import UIKit
import AVFoundation
import Capacitor
import WebKit

/// Host for ListenPage native audio bridge (completely refactored).
/// Direct WKScriptMessage + AVAudioPlayer queue + MPRemoteCommandCenter
/// for reliable background/lockscreen TTS.
class MainViewController: CAPBridgeViewController {
    override open func viewDidLoad() {
        super.viewDidLoad()
        attachAudioBridge()
    }

    override open func viewDidAppear(_ animated: Bool) {
        super.viewDidAppear(animated)
        attachAudioBridge()
    }

    private func attachAudioBridge() {
        guard let wv = self.webView else { return }
        BackgroundAudioBridge.shared.attach(to: wv)
    }
}
