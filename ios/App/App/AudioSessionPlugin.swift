import Foundation
import Capacitor
import AVFoundation

/// Re-asserts the .playback audio session category from JS right before
/// playback starts. WKWebView can silently reset the app's AVAudioSession
/// category back to a mute-switch-respecting one the first time an
/// <audio>/AudioContext plays, which is why setting it once in
/// AppDelegate alone isn't always enough to play through the silent switch.
@objc(AudioSessionPlugin)
public class AudioSessionPlugin: CAPPlugin, CAPBridgedPlugin {
    public let identifier = "AudioSessionPlugin"
    public let jsName = "AudioSession"
    public let pluginMethods: [CAPPluginMethod] = [
        CAPPluginMethod(name: "activate", returnType: CAPPluginReturnPromise)
    ]

    @objc func activate(_ call: CAPPluginCall) {
        do {
            let session = AVAudioSession.sharedInstance()
            try session.setCategory(.playback, mode: .spokenAudio, options: [])
            try session.setActive(true, options: [])
            call.resolve()
        } catch {
            call.reject("Failed to activate audio session: \(error.localizedDescription)")
        }
    }
}
