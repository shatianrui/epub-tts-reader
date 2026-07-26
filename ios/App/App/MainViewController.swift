import UIKit
import AVFoundation
import Capacitor
import WebKit

/// Host for ListenPage native bridges. Attaches BackgroundAudioBridge to the
/// WKWebView so TTS can use AVAudioPlayer without Capacitor plugin registration.
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        // Secondary path: Capacitor plugin registration (may be a no-op if
        // packageClassList discovery fails — WK bridge is the primary path).
        bridge?.registerPluginInstance(BackgroundAudioPlugin())
    }

    override open func viewDidLoad() {
        super.viewDidLoad()
        attachAudioBridge()
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Re-attach after webview is fully up (cap load order varies).
        attachAudioBridge()
    }

    private func attachAudioBridge() {
        guard let wv = self.webView else { return }
        BackgroundAudioBridge.shared.attach(to: wv)
        let session = AVAudioSession.sharedInstance()
        try? session.setCategory(
            .playback,
            mode: .spokenAudio,
            options: [.allowAirPlay, .allowBluetoothA2DP]
        )
        try? session.setActive(true)
    }
}
