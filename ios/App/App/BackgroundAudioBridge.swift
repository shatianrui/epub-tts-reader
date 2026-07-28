import Foundation
import WebKit
import AVFoundation
import MediaPlayer
import UIKit

/**
 * Direct WKScriptMessageHandler bridge for background TTS (PRIMARY on iOS).
 * Avoids flaky Capacitor local plugin registration.
 *
 * JS API (window.ListenPageAudio):
 *   enqueue({ base64, id?, gapAfterMs? }) -> Promise
 *   stop() / pause() / resume() / isPlaying()
 *   events via window.__listenPageAudioEvent(name, data)
 */
final class BackgroundAudioBridge: NSObject, WKScriptMessageHandler, AVAudioPlayerDelegate {
    static let handlerName = "listenPageAudio"
    static let shared = BackgroundAudioBridge()

    private struct QueuedClip {
        let id: String
        let data: Data
        let gapAfterMs: Double
        let requestId: String?
    }

    private weak var webView: WKWebView?
    private var queue: [QueuedClip] = []
    private var player: AVAudioPlayer?
    private var defaultGapMs: Double = 50
    private var currentGapAfterMs: Double = 50
    private var gapWorkItem: DispatchWorkItem?
    private var currentId: String?
    private let lock = NSLock()

    func attach(to webView: WKWebView) {
        self.webView = webView
        let ucc = webView.configuration.userContentController
        // Remove previous handler if re-attaching
        ucc.removeScriptMessageHandler(forName: Self.handlerName)
        ucc.add(self, name: Self.handlerName)
        ucc.addUserScript(Self.bootstrapScript)
        activateSession()
    }

    private static var bootstrapScript: WKUserScript {
        let js = """
        (function() {
          if (window.ListenPageAudio) return;
          var pending = {};
          var seq = 0;
          function rid() { return 'r' + (++seq) + '_' + Date.now(); }
          function call(action, payload) {
            return new Promise(function(resolve, reject) {
              var id = rid();
              pending[id] = { resolve: resolve, reject: reject };
              try {
                window.webkit.messageHandlers.\(Self.handlerName).postMessage(
                  Object.assign({ action: action, requestId: id }, payload || {})
                );
              } catch (e) {
                delete pending[id];
                reject(e);
              }
            });
          }
          window.__listenPageAudioReply = function(msg) {
            if (!msg || !msg.requestId) return;
            var p = pending[msg.requestId];
            if (!p) return;
            delete pending[msg.requestId];
            if (msg.error) p.reject(new Error(msg.error));
            else p.resolve(msg.result || {});
          };
          window.__listenPageAudioEvent = function(name, data) {
            try {
              window.dispatchEvent(new CustomEvent('listenpage-audio', {
                detail: { name: name, data: data || {} }
              }));
            } catch (e) {}
          };
          window.ListenPageAudio = {
            enqueue: function(opts) { return call('enqueue', opts || {}); },
            stop: function() { return call('stop', {}); },
            pause: function() { return call('pause', {}); },
            resume: function() { return call('resume', {}); },
            setGapMs: function(opts) { return call('setGapMs', opts || {}); },
            isPlaying: function() { return call('isPlaying', {}); }
          };
        })();
        """
        return WKUserScript(source: js, injectionTime: .atDocumentStart, forMainFrameOnly: false)
    }

    func userContentController(_ userContentController: WKUserContentController, didReceive message: WKScriptMessage) {
        guard message.name == Self.handlerName,
              let body = message.body as? [String: Any],
              let action = body["action"] as? String else { return }

        let requestId = body["requestId"] as? String

        switch action {
        case "enqueue":
            enqueue(body: body, requestId: requestId)
        case "stop":
            clearAll()
            reply(requestId: requestId, result: [:])
        case "pause":
            player?.pause()
            emit("paused", [:])
            reply(requestId: requestId, result: [:])
        case "resume":
            activateSession()
            if let player = player, !player.isPlaying {
                player.play()
                emit("resumed", ["id": currentId as Any])
            } else if player == nil {
                playNext()
            }
            reply(requestId: requestId, result: [:])
        case "setGapMs":
            if let ms = body["ms"] as? Double {
                defaultGapMs = max(0, ms)
            } else if let ms = body["ms"] as? Int {
                defaultGapMs = max(0, Double(ms))
            }
            reply(requestId: requestId, result: [:])
        case "isPlaying":
            reply(requestId: requestId, result: [
                "playing": player?.isPlaying == true,
                "queueLength": queueCount(),
                "currentId": currentId as Any,
            ])
        default:
            reply(requestId: requestId, error: "unknown action \(action)")
        }
    }

    private func enqueue(body: [String: Any], requestId: String?) {
        guard let b64 = body["base64"] as? String, !b64.isEmpty else {
            reply(requestId: requestId, error: "base64 required")
            return
        }
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !data.isEmpty else {
            reply(requestId: requestId, error: "invalid base64 audio")
            return
        }
        let id = (body["id"] as? String).flatMap { $0.isEmpty ? nil : $0 } ?? UUID().uuidString
        var gap = defaultGapMs
        if let g = body["gapAfterMs"] as? Double { gap = max(0, g) }
        else if let g = body["gapAfterMs"] as? Int { gap = max(0, Double(g)) }

        activateSession()

        lock.lock()
        let shouldStart = player == nil || player?.isPlaying != true
        queue.append(QueuedClip(id: id, data: data, gapAfterMs: gap, requestId: nil))
        lock.unlock()

        emit("enqueued", ["id": id, "queueLength": queueCount()])
        reply(requestId: requestId, result: ["id": id])

        if shouldStart {
            playNext()
        }
    }

    private func queueCount() -> Int {
        lock.lock(); defer { lock.unlock() }
        return queue.count
    }

    private func clearAll() {
        gapWorkItem?.cancel()
        gapWorkItem = nil
        lock.lock(); queue.removeAll(); lock.unlock()
        player?.stop()
        player = nil
        currentId = nil
        emit("stopped", [:])
    }

    private func activateSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.allowAirPlay, .allowBluetoothA2DP]
            )
            try session.setActive(true)
        } catch {
            NSLog("ListenPageAudio session error: \(error.localizedDescription)")
        }
    }

    private func playNext() {
        gapWorkItem?.cancel()
        gapWorkItem = nil

        lock.lock()
        guard !queue.isEmpty else {
            lock.unlock()
            player = nil
            currentId = nil
            emit("queueEmpty", [:])
            return
        }
        let clip = queue.removeFirst()
        lock.unlock()

        activateSession()

        do {
            let p = try AVAudioPlayer(data: clip.data)
            p.delegate = self
            p.prepareToPlay()
            p.volume = 1
            guard p.play() else {
                emit("error", ["message": "play() returned false", "id": clip.id])
                DispatchQueue.main.async { [weak self] in self?.playNext() }
                return
            }
            player = p
            currentId = clip.id
            currentGapAfterMs = clip.gapAfterMs
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPMediaItemPropertyTitle] = "听页 ListenPage"
            info[MPMediaItemPropertyArtist] = "EPUB 朗读"
            info[MPNowPlayingInfoPropertyPlaybackRate] = 1.0
            info[MPMediaItemPropertyPlaybackDuration] = p.duration
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0.0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            emit("trackStart", [
                "id": clip.id,
                "duration": p.duration,
                "queueLength": queueCount(),
            ])
        } catch {
            emit("error", ["message": error.localizedDescription, "id": clip.id])
            DispatchQueue.main.async { [weak self] in self?.playNext() }
        }
    }

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finishedId = currentId
        emit("trackEnded", ["id": finishedId as Any, "successfully": flag])
        let delay = currentGapAfterMs / 1000.0
        if delay <= 0.001 {
            playNext()
            return
        }
        let work = DispatchWorkItem { [weak self] in self?.playNext() }
        gapWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        emit("error", [
            "message": error?.localizedDescription ?? "decode error",
            "id": currentId as Any,
        ])
        playNext()
    }

    private func reply(requestId: String?, result: [String: Any]? = nil, error: String? = nil) {
        guard let requestId = requestId else { return }
        var msg: [String: Any] = ["requestId": requestId]
        if let error = error { msg["error"] = error }
        if let result = result { msg["result"] = result }
        eval("__listenPageAudioReply", msg)
    }

    private func emit(_ name: String, _ data: [String: Any]) {
        eval("__listenPageAudioEvent", ["name": name, "data": data])
        // Also call as function(name, data)
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { return }
            guard let dataJSON = try? JSONSerialization.data(withJSONObject: data, options: []),
                  let dataStr = String(data: dataJSON, encoding: .utf8) else { return }
            let nameEsc = name.replacingOccurrences(of: "\\", with: "\\\\")
                .replacingOccurrences(of: "'", with: "\\'")
            let js = "window.__listenPageAudioEvent && window.__listenPageAudioEvent('\(nameEsc)', \(dataStr));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    private func eval(_ fn: String, _ payload: [String: Any]) {
        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { return }
            guard let data = try? JSONSerialization.data(withJSONObject: payload, options: []),
                  let json = String(data: data, encoding: .utf8) else { return }
            let js = "window.\(fn) && window.\(fn)(\(json));"
            webView.evaluateJavaScript(js, completionHandler: nil)
        }
    }

    // MARK: - Helpers for remote commands (from AppDelegate)

    func resumeIfNeeded() {
        if let p = player, !p.isPlaying {
            p.play()
        } else if player == nil {
            // nothing queued
        }
    }

    func pauseIfNeeded() {
        player?.pause()
    }

    func togglePlayPause() {
        if let p = player {
            if p.isPlaying {
                p.pause()
            } else {
                p.play()
            }
        }
    }

    func skipForward() {
        // Skip current clip
        player?.stop()
        player = nil
        // The queue will continue on next playNext if called from JS, or we can trigger
        // For simplicity, let the current flow continue; JS layer controls queue.
    }

    func skipBackward() {
        if let p = player {
            p.currentTime = 0
            p.play()
        }
    }
}
