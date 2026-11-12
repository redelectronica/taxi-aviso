/**
 * Background queue monitor — con Foreground Service para Android.
 *
 * PROBLEMA ORIGINAL: BackgroundFetch tiene un mínimo de 15 minutos en Android
 * por restricciones del sistema operativo (Doze mode / WorkManager).
 *
 * SOLUCIÓN: Foreground Service — un servicio que Android no puede suspender,
 * igual que el reloj despertador o Waze. Muestra una notificación permanente
 * en la barra de estado mientras está activo, pero chequea la fila cada 30
 * segundos aunque el celular esté en stand-by o con otra app abierta.
 *
 * IMPORTANTE: TaskManager.defineTask() MUST be called at module scope.
 * Este archivo se importa en app/_layout.tsx.
 */

import * as TaskManager from 'expo-task-manager';
import * as BackgroundFetch from 'expo-background-fetch';
import * as Notifications from 'expo-notifications';
import AsyncStorage from '@react-native-async-storage/async-storage';
import { Platform, AppState, AppStateStatus } from 'react-native';
import { parseQueueHTML } from '@/utils/parseQueue';
import { DEFAULT_MOBILE_NUMBER, MOBILE_NUMBER_KEY } from '@/constants/monitor';
import VIForegroundService from '@voximplant/react-native-foreground-service';

export const BACKGROUND_FETCH_TASK = 'background-queue-monitor';
export const ALARM_CHANNEL_ID      = 'alarm';
export const SERVICE_CHANNEL_ID    = 'monitor-service';

const POLL_URL         = 'https://taxis.hosting.servimatica.com.uy/fila/ajax/fila.php';
const THRESHOLD_KEY    = '@monitor/threshold';
const LAST_ALERTED_KEY = '@monitor/lastAlertedPosition';

// Intervalo en segundos mientras el foreground service está activo
const POLL_INTERVAL_S  = 30;

// ─── Referencia al timer del foreground service ───────────────────────────────
let _pollTimer: ReturnType<typeof setInterval> | null = null;

// ─── Función principal de polling ────────────────────────────────────────────
async function checkQueue(): Promise<void> {
  try {
    const resp = await fetch(POLL_URL, { method: 'POST' });
    if (!resp.ok) return;

    const html    = await resp.text();
    const entries = parseQueueHTML(html);

    const mobileStr      = await AsyncStorage.getItem(MOBILE_NUMBER_KEY);
    const configuredMobile = mobileStr ? Number.parseInt(mobileStr, 10) : DEFAULT_MOBILE_NUMBER;
    const targetMobile   =
      Number.isSafeInteger(configuredMobile) && configuredMobile > 0
        ? configuredMobile
        : DEFAULT_MOBILE_NUMBER;

    const target = entries.find((e) => e.mobile === targetMobile);
    if (!target) return;

    const thresholdStr = await AsyncStorage.getItem(THRESHOLD_KEY);
    const threshold    = thresholdStr ? parseInt(thresholdStr, 10) : 6;

    if (target.position <= threshold) {
      const lastStr = await AsyncStorage.getItem(LAST_ALERTED_KEY);
      const lastPos = lastStr ? parseInt(lastStr, 10) : null;

      if (lastPos === null || target.position < lastPos) {
        await Notifications.scheduleNotificationAsync({
          content: {
            title:    `🚕 ¡ALERTA! Móvil ${targetMobile} en la fila`,
            body:     `Posición ${target.position} ≤ umbral ${threshold}. ¡Estás cerca!`,
            sound:    true,
            priority: Notifications.AndroidNotificationPriority.MAX,
            vibrate:  [0, 400, 200, 400, 200, 400],
            color:    '#FF3B30',
            sticky:   true,
            data:     { position: target.position, mobile: targetMobile },
          },
          trigger: { channelId: ALARM_CHANNEL_ID },
        });
        await AsyncStorage.setItem(LAST_ALERTED_KEY, String(target.position));
      }
    } else {
      await AsyncStorage.removeItem(LAST_ALERTED_KEY);
    }
  } catch (e) {
    console.error('[BackgroundMonitor] checkQueue error:', e);
  }
}

// ─── Foreground Service (Android) ────────────────────────────────────────────
// Arranca un servicio persistente que Android no puede matar.
// Aparece una notificación fija en la barra de estado.

async function createServiceChannel(): Promise<void> {
  if (Platform.OS !== 'android') return;
  await VIForegroundService.getInstance().createNotificationChannel({
    id:          SERVICE_CHANNEL_ID,
    name:        'Monitor de Fila activo',
    description: 'Servicio en segundo plano del Monitor de Fila',
    enableVibration: false,
  });
}

export async function startForegroundService(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    await createServiceChannel();

    await VIForegroundService.getInstance().startService({
      channelId:   SERVICE_CHANNEL_ID,
      id:          1001,
      title:       'Monitor de Fila activo',
      text:        'Monitoreando tu posición en la fila...',
      icon:        'ic_launcher_round',
      button:      false,
    });

    // Arranca el polling cada 30 segundos
    if (_pollTimer) clearInterval(_pollTimer);
    await checkQueue(); // primera verificación inmediata
    _pollTimer = setInterval(checkQueue, POLL_INTERVAL_S * 1000);

    console.log('[ForegroundService] Iniciado — polling cada', POLL_INTERVAL_S, 's');
  } catch (e) {
    console.error('[ForegroundService] startForegroundService error:', e);
  }
}

export async function stopForegroundService(): Promise<void> {
  if (Platform.OS !== 'android') return;

  try {
    if (_pollTimer) {
      clearInterval(_pollTimer);
      _pollTimer = null;
    }
    await VIForegroundService.getInstance().stopService();
    console.log('[ForegroundService] Detenido');
  } catch (e) {
    console.error('[ForegroundService] stopForegroundService error:', e);
  }
}

// ─── BackgroundFetch (fallback para iOS y Android en segundo plano) ───────────
// Se mantiene como red de seguridad. En Android el Foreground Service
// hace el trabajo principal; BackgroundFetch actúa si el servicio se cae.

TaskManager.defineTask(BACKGROUND_FETCH_TASK, async () => {
  try {
    await checkQueue();
    return BackgroundFetch.BackgroundFetchResult.NewData;
  } catch (e) {
    console.error('[BackgroundMonitor] task error:', e);
    return BackgroundFetch.BackgroundFetchResult.Failed;
  }
});

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

    const alreadyRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (!alreadyRegistered) {
      await BackgroundFetch.registerTaskAsync(BACKGROUND_FETCH_TASK, {
        minimumInterval: 60 * 15,
        stopOnTerminate: false,
        startOnBoot:     true,
      });
    }

    // En Android arranca también el Foreground Service
    await startForegroundService();
    return true;
  } catch (e) {
    console.error('[BackgroundMonitor] registerBackgroundMonitor error:', e);
    return false;
  }
}

export async function unregisterBackgroundMonitor(): Promise<void> {
  try {
    await stopForegroundService();
    const isRegistered = await TaskManager.isTaskRegisteredAsync(BACKGROUND_FETCH_TASK);
    if (isRegistered) {
      await BackgroundFetch.unregisterTaskAsync(BACKGROUND_FETCH_TASK);
    }
  } catch (e) {
    console.error('[BackgroundMonitor] unregisterBackgroundMonitor error:', e);
  }
}

// ─── Helpers de notificación ─────────────────────────────────────────────────

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
      trigger: { channelId: ALARM_CHANNEL_ID },
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
