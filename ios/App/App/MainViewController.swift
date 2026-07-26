import UIKit
import AVFoundation
import Capacitor
import WebKit

/// Host for ListenPage native audio bridge.
/// We use the direct WKScriptMessage bridge (BackgroundAudioBridge) exclusively
/// for reliable AVAudioPlayer background/lockscreen TTS (avoids Capacitor
/// local plugin registration flakiness).
class MainViewController: CAPBridgeViewController {
    override open func viewDidLoad() {
        super.viewDidLoad()
        attachAudioBridge()
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        // Re-attach after webview is fully up.
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
