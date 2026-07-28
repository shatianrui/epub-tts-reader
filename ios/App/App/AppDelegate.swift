import UIKit
import Capacitor
import AVFoundation
import MediaPlayer

@UIApplicationMain
class AppDelegate: UIResponder, UIApplicationDelegate {

    var window: UIWindow?

    func application(_ application: UIApplication, didFinishLaunchingWithOptions launchOptions: [UIApplication.LaunchOptionsKey: Any]?) -> Bool {
        configureAudioSession()
        observeAudioSession()
        UIApplication.shared.beginReceivingRemoteControlEvents()
        setupRemoteCommands()
        return true
    }

    private func setupRemoteCommands() {
        let cc = MPRemoteCommandCenter.shared()
        cc.playCommand.addTarget { _ in
            // Delegate to the bridge (it will resume if possible)
            BackgroundAudioBridge.shared.resumeIfNeeded()
            return .success
        }
        cc.pauseCommand.addTarget { _ in
            BackgroundAudioBridge.shared.pauseIfNeeded()
            return .success
        }
        cc.togglePlayPauseCommand.addTarget { _ in
            BackgroundAudioBridge.shared.togglePlayPause()
            return .success
        }
        cc.nextTrackCommand.addTarget { _ in
            BackgroundAudioBridge.shared.skipForward()
            return .success
        }
        cc.previousTrackCommand.addTarget { _ in
            BackgroundAudioBridge.shared.skipBackward()
            return .success
        }
    }

    /// Playback category + spokenAudio mode keeps TTS alive with the screen locked
    /// and the app backgrounded (requires UIBackgroundModes → audio in Info.plist).
    private func configureAudioSession() {
        let session = AVAudioSession.sharedInstance()
        do {
            try session.setCategory(
                .playback,
                mode: .spokenAudio,
                options: [.allowAirPlay, .allowBluetoothA2DP]
            )
            try session.setActive(true, options: [])
        } catch {
            NSLog("AVAudioSession configure failed: \(error.localizedDescription)")
        }
    }

    private func observeAudioSession() {
        let nc = NotificationCenter.default
        nc.addObserver(
            self,
            selector: #selector(handleInterruption),
            name: AVAudioSession.interruptionNotification,
            object: AVAudioSession.sharedInstance()
        )
        nc.addObserver(
            self,
            selector: #selector(handleRouteChange),
            name: AVAudioSession.routeChangeNotification,
            object: AVAudioSession.sharedInstance()
        )
        nc.addObserver(
            self,
            selector: #selector(handleMediaReset),
            name: AVAudioSession.mediaServicesWereResetNotification,
            object: AVAudioSession.sharedInstance()
        )
    }

    @objc private func handleInterruption(_ notification: Notification) {
        guard
            let info = notification.userInfo,
            let typeValue = info[AVAudioSessionInterruptionTypeKey] as? UInt,
            let type = AVAudioSession.InterruptionType(rawValue: typeValue)
        else { return }

        switch type {
        case .began:
            break
        case .ended:
            let options = (info[AVAudioSessionInterruptionOptionKey] as? UInt)
                .map { AVAudioSession.InterruptionOptions(rawValue: $0) }
            if options?.contains(.shouldResume) != false {
                try? AVAudioSession.sharedInstance().setActive(true)
            }
        @unknown default:
            break
        }
    }

    @objc private func handleRouteChange(_ notification: Notification) {
        // Re-assert playback session after route changes (Bluetooth / AirPlay).
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    @objc private func handleMediaReset(_ notification: Notification) {
        configureAudioSession()
    }

    func applicationWillResignActive(_ application: UIApplication) {
        // Keep session active so WKWebView / Web Audio can continue speaking.
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    func applicationDidEnterBackground(_ application: UIApplication) {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    func applicationWillEnterForeground(_ application: UIApplication) {
        try? AVAudioSession.sharedInstance().setActive(true)
    }

    func applicationDidBecomeActive(_ application: UIApplication) {
        configureAudioSession()
    }

    func applicationWillTerminate(_ application: UIApplication) {
        UIApplication.shared.endReceivingRemoteControlEvents()
        NotificationCenter.default.removeObserver(self)
    }

    func application(_ app: UIApplication, open url: URL, options: [UIApplication.OpenURLOptionsKey: Any] = [:]) -> Bool {
        return ApplicationDelegateProxy.shared.application(app, open: url, options: options)
    }

    func application(_ application: UIApplication, continue userActivity: NSUserActivity, restorationHandler: @escaping ([UIUserActivityRestoring]?) -> Void) -> Bool {
        return ApplicationDelegateProxy.shared.application(application, continue: userActivity, restorationHandler: restorationHandler)
    }

}
