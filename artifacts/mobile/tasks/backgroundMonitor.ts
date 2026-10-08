/**
 * Background queue monitor task.
 *
 * IMPORTANT: TaskManager.defineTask() MUST be called at module scope
 * (not inside a component or hook). This file is imported in app/_layout.tsx
 * so the task is always registered before it could fire.
 *
 * Background fetch minimum interval:
 *   - Android: ~15 min (WorkManager / Doze mode OS floor)
 *   - iOS:     system-controlled, typically 15–30 min
 *
 * While in the foreground the app polls every 30 s as before.
 * The background task provides a safety net with a local notification
 * that plays sound even when the screen is off.
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { parseQueueHTML } from '@/utils/parseQueue';
import { DEFAULT_MOBILE_NUMBER, MOBILE_NUMBER_KEY } from '@/constants/monitor';

export const BACKGROUND_FETCH_TASK = 'background-queue-monitor';
export const ALARM_CHANNEL_ID      = 'alarm';

const POLL_URL          = 'https://taxis.hosting.servimatica.com.uy/fila/ajax/fila.php';
const THRESHOLD_KEY     = '@monitor/threshold';
const LAST_ALERTED_KEY  = '@monitor/lastAlertedPosition';

// ─── Task definition (module scope — required by TaskManager) ────────────────

TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    const resp = await fetch(POLL_URL, { method: 'POST' });
    if (!resp.ok) return BackgroundFetch.BackgroundFetchResult.Failed;

    const html    = await resp.text();
    const entries = parseQueueHTML(html);
    const mobileStr = await AsyncStorage.getItem(MOBILE_NUMBER_KEY);
    const configuredMobile = mobileStr ? Number.parseInt(mobileStr, 10) : DEFAULT_MOBILE_NUMBER;
    const targetMobile =
      Number.isSafeInteger(configuredMobile) && configuredMobile > 0
        ? configuredMobile
        : DEFAULT_MOBILE_NUMBER;
    const target  = entries.find((e) => e.mobile === targetMobile);

    if (!target) return BackgroundFetch.BackgroundFetchResult.NoData;

    const thresholdStr = await AsyncStorage.getItem(THRESHOLD_KEY);
    const threshold    = thresholdStr ? parseInt(thresholdStr, 10) : 6;

    if (target.position <= threshold) {
      const lastStr    = await AsyncStorage.getItem(LAST_ALERTED_KEY);
      const lastPos    = lastStr ? parseInt(lastStr, 10) : null;

      // Fire only if position decreased since last alert (avoids repeat spam)
      if (lastPos === null || target.position < lastPos) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title:     `🚕 ¡ALERTA! Móvil ${targetMobile} en la fila`,
            body:      `Posición ${target.position} ≤ umbral ${threshold}. ¡Estás cerca!`,
            sound:     true,
            priority:  Notifications.AndroidNotificationPriority.MAX,
            vibrate:   [0, 400, 200, 400, 200, 400],
            color:     '#FF3B30',
            sticky:    true,
            data:      { position: target.position, mobile: targetMobile },
          },
          trigger: {
            channelId: ALARM_CHANNEL_ID,
          },
        });
        await AsyncStorage.setItem(LAST_ALERTED_KEY, String(target.position));
      }
    } else {
      // Position recovered above threshold — reset so next drop re-alerts
      await AsyncStorage.removeItem(LAST_ALERTED_KEY);
    }

    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.error('[BackgroundMonitor] fetch error:', e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

// ─── Registration helpers ────────────────────────────────────────────────────

export async function registerBackgroundMonitor(): Promise<boolean> {
  try {
    const status = await BackgroundFetch.getStatusAsync();
    if (
      status === BackgroundFetch.BackgroundFetchStatus.Restricted ||
      status === BackgroundFetch.BackgroundFetchStatus.Denied
    ) {
      console.warn('[BackgroundMonitor] Background fetch unavailable:', status);
      return false;
    }

    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(
      BACKGROUND_FETCH_TASK,
    );
    if (!alreadyRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 60 * 15, // 15 min — Android/iOS OS minimum
        stopOnTerminate: false,   // keep running after app is killed
        startOnBoot: true,        // re-register after device reboot
      });
    }
    return true;
  } catch (e) {
    console.error('[BackgroundMonitor] registerBackgroundMonitor error:', e);
    return false;
  }
}

export async function unregisterBackgroundMonitor(): Promise<void> {
  try {
    const isRegistered = await TaskManager.isTaskRegisteredAsync(
      BACKGROUND_FETCH_TASK,
    );
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
    }
  } catch (e) {
    console.error('[BackgroundMonitor] unregisterBackgroundMonitor error:', e);
  }
}

// ─── Foreground notification helper ─────────────────────────────────────────
// Called from index.tsx when alarm triggers in the foreground so the
// notification appears in the shade even while the app is open.

export async function fireAlarmNotification(
  position: number,
  threshold: number,
  mobileNumber: number,
) {
  try {
    await Notifications.scheduleNotificationAsync({
      content: {
        title:    `🚕 ¡ALERTA! Móvil ${mobileNumber} en la fila`,
        body:     `Posición ${position} ≤ umbral ${threshold}. ¡Estás cerca!`,
        sound:    true,
        priority: Notifications.AndroidNotificationPriority.MAX,
        vibrate:  [0, 400, 200, 400, 200, 400],
        color:    '#FF3B30',
        sticky:   true,
        data:     { position, mobile: mobileNumber },
      },
      trigger: {
        channelId: ALARM_CHANNEL_ID,
      },
    });
    await AsyncStorage.setItem(LAST_ALERTED_KEY, String(position));
  } catch (e) {
    console.warn('[BackgroundMonitor] fireAlarmNotification error:', e);
  }
}

export async function resetAlertState() {
  try {
    await AsyncStorage.removeItem(LAST_ALERTED_KEY);
  } catch (_) {}
}
