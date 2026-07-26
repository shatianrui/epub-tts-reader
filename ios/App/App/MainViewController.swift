import UIKit
import Capacitor

/// Registers in-app Capacitor plugins that are not published as npm packages
/// (cap sync only auto-registers packageClassList from node_modules).
class MainViewController: CAPBridgeViewController {
    override open func capacitorDidLoad() {
        bridge?.registerPluginInstance(BackgroundAudioPlugin())
    }
}
