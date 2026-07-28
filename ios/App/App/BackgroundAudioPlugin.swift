import Foundation
import Capacitor
import AVFoundation
import MediaPlayer
import UIKit

/**
 * Legacy Capacitor plugin (kept for backward compatibility).
 * Completely refactored background playback lives in BackgroundAudioBridge.swift
 * (direct WKScriptMessage + AVAudioPlayer queue + MPRemoteCommandCenter).
 */
@objc(BackgroundAudioPlugin)
public class BackgroundAudioPlugin: CAPPlugin, CAPBridgedPlugin, AVAudioPlayerDelegate {
    public let identifier = "BackgroundAudioPlugin"
    public let jsName = "BackgroundAudio"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "enqueue", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "stop", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "pause", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "resume", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "setGapMs", returnType: CAPPluginReturnPromise),
        CAPPluginMethod(name: "isPlaying", returnType: CAPPluginReturnPromise),
    ]

    private struct QueuedClip {
        let id: String
        let data: Data
        let gapAfterMs: Double
    }

    private var queue: [QueuedClip] = []
    private var player: AVAudioPlayer?
    private var defaultGapMs: Double = 50
    private var currentGapAfterMs: Double = 50
    private var gapWorkItem: DispatchWorkItem?
    private var currentId: String?
    private let lock = NSLock()
    private var isSessionReady = false

    public override func load() {
        super.load()
        activateSession()
        UIApplication.shared.beginReceivingRemoteControlEvents()
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
            isSessionReady = true
        } catch {
            CAPLog.print("BackgroundAudio session error: \(error.localizedDescription)")
            isSessionReady = false
        }
    }

    @objc public func setGapMs(_ call: CAPPluginCall) {
        defaultGapMs = max(0, call.getDouble("ms") ?? 50)
        call.resolve()
    }

    @objc public func enqueue(_ call: CAPPluginCall) {
        guard let b64 = call.getString("base64"), !b64.isEmpty else {
            call.reject("base64 required")
            return
        }
        guard let data = Data(base64Encoded: b64, options: .ignoreUnknownCharacters), !data.isEmpty else {
            call.reject("invalid base64 audio")
            return
        }
        let id = call.getString("id") ?? UUID().uuidString
        let gapAfterMs = call.getDouble("gapAfterMs") ?? defaultGapMs

        activateSession()

        lock.lock()
        let shouldStart = player == nil || player?.isPlaying != true
        queue.append(QueuedClip(id: id, data: data, gapAfterMs: max(0, gapAfterMs)))
        lock.unlock()

        notifyListeners("enqueued", data: ["id": id, "queueLength": queueCount()])

        if shouldStart {
            playNext()
        }
        call.resolve(["id": id])
    }

    @objc public func stop(_ call: CAPPluginCall) {
        clearAll()
        call.resolve()
    }

    @objc public func pause(_ call: CAPPluginCall) {
        player?.pause()
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = .paused
        }
        notifyListeners("paused", data: [:])
        call.resolve()
    }

    @objc public func resume(_ call: CAPPluginCall) {
        activateSession()
        if let player = player, !player.isPlaying {
            player.play()
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .playing
            }
            notifyListeners("resumed", data: ["id": currentId as Any])
        } else if player == nil {
            playNext()
        }
        call.resolve()
    }

    @objc public func isPlaying(_ call: CAPPluginCall) {
        let playing = player?.isPlaying == true
        call.resolve(["playing": playing, "queueLength": queueCount(), "currentId": currentId as Any])
    }

    private func queueCount() -> Int {
        lock.lock()
        defer { lock.unlock() }
        return queue.count
    }

    private func clearAll() {
        gapWorkItem?.cancel()
        gapWorkItem = nil
        lock.lock()
        queue.removeAll()
        lock.unlock()
        if let player = player {
            player.stop()
        }
        player = nil
        currentId = nil
        if #available(iOS 13.0, *) {
            MPNowPlayingInfoCenter.default().playbackState = .stopped
        }
        notifyListeners("stopped", data: [:])
    }

    private func playNext() {
        gapWorkItem?.cancel()
        gapWorkItem = nil

        lock.lock()
        guard !queue.isEmpty else {
            lock.unlock()
            player = nil
            currentId = nil
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .stopped
            }
            notifyListeners("queueEmpty", data: [:])
            return
        }
        let clip = queue.removeFirst()
        lock.unlock()

        activateSession()

        do {
            let p = try AVAudioPlayer(data: clip.data)
            p.delegate = self
            p.prepareToPlay()
            p.volume = 1.0
            guard p.play() else {
                notifyListeners("error", data: ["message": "play() returned false", "id": clip.id])
                // try subsequent clip
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
            info[MPNowPlayingInfoPropertyElapsedPlaybackTime] = 0
            MPNowPlayingInfoCenter.default().nowPlayingInfo = info
            if #available(iOS 13.0, *) {
                MPNowPlayingInfoCenter.default().playbackState = .playing
            }
            notifyListeners("trackStart", data: [
                "id": clip.id,
                "duration": p.duration,
                "queueLength": queueCount(),
            ])
        } catch {
            notifyListeners("error", data: [
                "message": error.localizedDescription,
                "id": clip.id,
            ])
            DispatchQueue.main.async { [weak self] in self?.playNext() }
        }
    }

    public func audioPlayerDidFinishPlaying(_ player: AVAudioPlayer, successfully flag: Bool) {
        let finishedId = currentId
        let delay = currentGapAfterMs / 1000.0
        notifyListeners("trackEnded", data: [
            "id": finishedId as Any,
            "successfully": flag,
        ])

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

    public func audioPlayerDecodeErrorDidOccur(_ player: AVAudioPlayer, error: Error?) {
        notifyListeners("error", data: [
            "message": error?.localizedDescription ?? "decode error",
            "id": currentId as Any,
        ])
        playNext()
    }
}
