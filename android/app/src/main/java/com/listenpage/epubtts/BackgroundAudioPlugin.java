package com.listenpage.epubtts;

import android.content.Intent;
import android.os.Build;
import com.getcapacitor.Plugin;
import com.getcapacitor.PluginCall;
import com.getcapacitor.PluginMethod;
import com.getcapacitor.annotation.CapacitorPlugin;

@CapacitorPlugin(name = "BackgroundAudio")
public class BackgroundAudioPlugin extends Plugin {

    @PluginMethod
    public void start(PluginCall call) {
        String title = call.getString("title", "听页 ListenPage");
        String subtitle = call.getString("subtitle", "EPUB 朗读中");
        boolean playing = call.getBoolean("playing", true);

        Intent intent = new Intent(getContext(), MediaPlaybackService.class);
        intent.setAction(MediaPlaybackService.ACTION_START);
        intent.putExtra(MediaPlaybackService.EXTRA_TITLE, title);
        intent.putExtra(MediaPlaybackService.EXTRA_SUBTITLE, subtitle);
        intent.putExtra(MediaPlaybackService.EXTRA_PLAYING, playing);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        call.resolve();
    }

    @PluginMethod
    public void update(PluginCall call) {
        String title = call.getString("title", "听页 ListenPage");
        String subtitle = call.getString("subtitle", "EPUB 朗读中");
        boolean playing = call.getBoolean("playing", true);

        Intent intent = new Intent(getContext(), MediaPlaybackService.class);
        intent.setAction(MediaPlaybackService.ACTION_UPDATE);
        intent.putExtra(MediaPlaybackService.EXTRA_TITLE, title);
        intent.putExtra(MediaPlaybackService.EXTRA_SUBTITLE, subtitle);
        intent.putExtra(MediaPlaybackService.EXTRA_PLAYING, playing);

        if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.O) {
            getContext().startForegroundService(intent);
        } else {
            getContext().startService(intent);
        }

        call.resolve();
    }

    @PluginMethod
    public void stop(PluginCall call) {
        Intent intent = new Intent(getContext(), MediaPlaybackService.class);
        intent.setAction(MediaPlaybackService.ACTION_STOP);
        getContext().startService(intent);
        call.resolve();
    }
}
