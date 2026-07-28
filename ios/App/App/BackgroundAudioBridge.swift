import Foundation
import WebKit
import AVFoundation
import MediaPlayer
import UIKit

/**
 * Completely refactored background playback for iOS.
 *
 * - Uses direct WKScriptMessage (reliable in background, survives JS throttling)
 * - AVAudioPlayer queue for encoded audio clips (base64 from JS TTS)
 * - Proper AVAudioSession with .playback + .spokenAudio
 * - Full MPRemoteCommandCenter support (lock screen / Control Center controls)
 * - Clean NowPlayingInfo updates
 * - Better interruption / route handling delegated to AppDelegate
 * - Single source of truth (legacy Capacitor plugin kept only for compatibility)
 *
 * JS bridge (injected): window.ListenPageAudio
 *   enqueue({ base64, id?, gapAfterMs? })
 *   stop(), pause(), resume(), isPlaying(), setGapMs({ms})
 *
 * Events dispatched as 'listenpage-audio' CustomEvent and window.__listenPageAudioEvent(name, data)
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
    private var defaultGapMs: Double = 80
    private var currentGapAfterMs: Double = 80
    private var gapWorkItem: DispatchWorkItem?
    private var currentId: String?
    private let queueLock = NSLock()

    // Remote controls
    private var commandCenter: MPRemoteCommandCenter?

    // For periodic NowPlaying elapsed updates (lightweight)
    private var nowPlayingTimer: Timer?

    func attach(to webView: WKWebView) {
        self.webView = webView
        let ucc = webView.configuration.userContentController
        ucc.removeScriptMessageHandler(forName: Self.handlerName)
        ucc.add(self, name: Self.handlerName)
        ucc.addUserScript(Self.bootstrapScript)

        activateAudioSession()
        setupRemoteCommands()
        UIApplication.shared.beginReceivingRemoteControlEvents()
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

    // MARK: - Message handling

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
            pausePlayback()
            reply(requestId: requestId, result: [:])
        case "resume":
            resumePlayback()
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

        activateAudioSession()

        queueLock.lock()
        let shouldStart = player == nil || player?.isPlaying != true
        queue.append(QueuedClip(id: id, data: data, gapAfterMs: gap, requestId: nil))
        queueLock.unlock()

        emit("enqueued", ["id": id, "queueLength": queueCount()])
        reply(requestId: requestId, result: ["id": id])

        if shouldStart {
            playNext()
        }
    }

    // MARK: - Playback core (refactored queue)

    private func queueCount() -> Int {
        queueLock.lock(); defer { queueLock.unlock() }
        return queue.count
    }

    private func clearAll() {
        cancelGap()
        queueLock.lock(); queue.removeAll(); queueLock.unlock()
        player?.stop()
        player = nil
        currentId = nil
        stopNowPlayingTimer()
        updateNowPlayingStopped()
        emit("stopped", [:])
    }

    private func pausePlayback() {
        player?.pause()
        stopNowPlayingTimer()
        updateNowPlayingPaused()
        emit("paused", [:])
    }

    private func resumePlayback() {
        activateAudioSession()
        if let p = player, !p.isPlaying {
            p.play()
            startNowPlayingTimer()
            updateNowPlayingPlaying()
            emit("resumed", ["id": currentId as Any])
        } else if player == nil {
            playNext()
        }
    }

    private func playNext() {
        cancelGap()

        queueLock.lock()
        guard !queue.isEmpty else {
            queueLock.unlock()
            player = nil
            currentId = nil
            stopNowPlayingTimer()
            updateNowPlayingStopped()
            emit("queueEmpty", [:])
            return
        }
        let clip = queue.removeFirst()
        queueLock.unlock()

        activateAudioSession()

        do {
            let p = try AVAudioPlayer(data: clip.data)
            p.delegate = self
            p.prepareToPlay()
            p.volume = 1.0

            guard p.play() else {
                emit("error", ["message": "AVAudioPlayer.play() returned false", "id": clip.id])
                DispatchQueue.main.async { [weak self] in self?.playNext() }
                return
            }

            player = p
            currentId = clip.id
            currentGapAfterMs = clip.gapAfterMs

            updateNowPlaying(for: p, id: clip.id)
            startNowPlayingTimer()

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

    // MARK: - AVAudioPlayerDelegate

    func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finishedId = currentId
        emit("trackEnded", ["id": finishedId as Any, "successfully": flag])

        stopNowPlayingTimer()

        let delay = currentGapAfterMs / 1000.0
        if delay <= 0.001 {
            playNext()
            return
        }

        let work = DispatchWorkItem { [weak self] in
            self?.playNext()
        }
        gapWorkItem = work
        DispatchQueue.main.asyncAfter(deadline: .now() + delay, execute: work)
    }

    func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        emit("error", ["message": error?.localizedDescription ?? "decode error", "id": currentId as Any])
        playNext()
    }

    // MARK: - Audio Session

    private func activateAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.allowAirPlay, .allowBluetoothA2DP, .duckOthers]
            )
            try session.setActive(true, options: [])
        } catch {
            NSLog("ListenPageAudio session error: \(error.localizedDescription)")
        }
    }

    // MARK: - Remote Command Center (Lock Screen / Control Center)

    private func setupRemoteCommands() {
        commandCenter = MPRemoteCommandCenter.shared()

        // Play
        let cc = MPRemoteCommandCenter.shared()
        commandCenter = cc

        cc.playCommand.removeTarget(nil)
        cc.playCommand.addTarget { [weak self] _ in
            self?.resumePlayback()
            return MPRemoteCommandHandlerStatus.success
        }

        cc.pauseCommand.removeTarget(nil)
        cc.pauseCommand.addTarget { [weak self] _ in
            self?.pausePlayback()
            return MPRemoteCommandHandlerStatus.success
        }

        cc.togglePlayPauseCommand.removeTarget(nil)
        cc.togglePlayPauseCommand.addTarget { [weak self] _ in
            if let p = self?.player, p.isPlaying {
                self?.pausePlayback()
            } else {
                self?.resumePlayback()
            }
            return MPRemoteCommandHandlerStatus.success
        }

        cc.nextTrackCommand.removeTarget(nil)
        cc.nextTrackCommand.addTarget { [weak self] _ in
            self?.skipToNext()
            return MPRemoteCommandHandlerStatus.success
        }

        cc.previousTrackCommand.removeTarget(nil)
        cc.previousTrackCommand.addTarget { [weak self] _ in
            self?.skipToPrevious()
            return MPRemoteCommandHandlerStatus.success
        }

        cc.changePlaybackPositionCommand.isEnabled = false
    }

    private func skipToNext() {
        cancelGap()
        player?.stop()
        player = nil
        emit("skipped", ["direction": "next"])
        playNext()
    }

    private func skipToPrevious() {
        // For simplicity: restart current clip. A full history stack can be added later.
        cancelGap()
        if let p = player {
            p.currentTime = 0
            p.play()
            updateNowPlaying(for: p, id: currentId)
            emit("skipped", ["direction": "previous"])
        } else {
            playNext()
        }
    }

    // MARK: - Now Playing Info

    private func updateNowPlaying(for player: AVAudioPlayer, id: String?) {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPMediaItemPropertyTitle] = "听页 ListenPage"
        info[MPMediaItemPropertyArtist] = "EPUB 朗读"
        info[MPNowPlayingInfoPropertyPlaybackRate] = player.isPlaying ? 1.0 : 0.0
        info[MPMediaItemPropertyPlaybackDuration] = player.duration
        info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = player.currentTime
        info[MPNowPlayingInfoPropertyMediaType] = NSNumber(value: MPNowPlayingInfoMediaType.audio.rawValue)
        if let id = id {
            info[MPMediaItemPropertyAlbumTitle] = id
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = player.isPlaying ? .playing : .paused
        }
    }

    private func updateNowPlayingPaused() {
        var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
        info[MPNowPlayingInfoPropertyPlaybackRate] = 0.0
        if let p = player {
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime
        }
        MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = .paused
        }
    }

    private func updateNowPlayingStopped() {
        MPNowPlayingInfoCenter.default().nowPlayingInfo = nil
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = .stopped
        }
    }

    private func startNowPlayingTimer() {
        stopNowPlayingTimer()
        nowPlayingTimer = Timer.scheduledTimer(withTimeInterval: 1.0, repeats: true) { [weak self] _ in
            guard let self = self, let p = self.player, p.isPlaying else { return }
            var info = MPNowPlayingInfoCenter.default().nowPlayingInfo ?? [:]
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = p.currentTime
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
        }
    }

    private func stopNowPlayingTimer() {
        nowPlayingTimer?.invalidate()
        nowPlayingTimer = nil
    }

    private func cancelGap() {
        gapWorkItem?.cancel()
        gapWorkItem = nil
    }

    // MARK: - Messaging helpers

    private func reply(requestId: String?, result: [String: Any]? = nil, error: String? = nil) {
        guard let requestId = requestId else { return }
        var msg: [String: Any] = ["requestId": requestId]
        if let error = error { msg["error"] = error }
        if let result = result { msg["result"] = result }
        eval("__listenPageAudioReply", msg)
    }

    private func emit(_ name: String, _ data: [String: Any]) {
        eval("__listenPageAudioEvent", ["name": name, "data": data])

        DispatchQueue.main.async { [weak self] in
            guard let webView = self?.webView else { return }
            guard let dataJSON = try? JSONSerialization.data(withJSONObject: data, options: []),
                  let dataStr = String(data: dataJSON, encoding: .utf8) else { return }
            let nameEsc = name.replacingOccurrences(of: "\\", with: "\\\\").replacingOccurrences(of: "'", with: "\\'")
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
}
