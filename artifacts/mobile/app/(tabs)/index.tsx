import React, { useState, useEffect, useRef, useCallback, useMemo } from 'react';
import { useFocusEffect, useRouter } from 'expo-router';
import {
  View,
  Text,
  StyleSheet,
  TouchableOpacity,
  TextInput,
  Platform,
  StatusBar,
  ActivityIndicator,
  Alert,
} from 'react-native';
import { WebView } from 'react-native-webview';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import * as Notifications from 'expo-notifications';
import Animated, {
  useAnimatedStyle,
  useSharedValue,
  withRepeat,
  withSequence,
  withTiming,
  cancelAnimation,
} from 'react-native-reanimated';
import { useColors } from '@/hooks/useColors';
import { parseQueueHTML } from '@/utils/parseQueue';
import { DEFAULT_MOBILE_NUMBER, MOBILE_NUMBER_KEY } from '@/constants/monitor';
import {
  registerBackgroundMonitor,
  unregisterBackgroundMonitor,
  fireAlarmNotification,
  resetAlertState,
} from '@/tasks/backgroundMonitor';

const POLL_URL         = 'https://taxis.hosting.servimatica.com.uy/fila/ajax/fila.php';
const POLL_INTERVAL_MS = 30_000;
const THRESHOLD_KEY    = '@monitor/threshold';

// ─── Synthetic alarm — Web Audio API inside a hidden WebView ─────────────────
//
// Using oscillators avoids ALL native audio module init races.
// Two stacked square-wave oscillators (880 Hz + 1320 Hz) produce a piercing
// two-tone beep that repeats every 600 ms until stopAlarm() is called.
//
const ALARM_HTML = `<!DOCTYPE html>
<html>
<head>
  <meta name="viewport" content="width=device-width,initial-scale=1">
  <style>html,body{margin:0;padding:0;background:#000;}</style>
</head>
<body>
<script>
  var ctx   = null;
  var timer = null;

  function ensureCtx() {
    if (!ctx) ctx = new (window.AudioContext || window.webkitAudioContext)();
    if (ctx.state === 'suspended') ctx.resume();
  }

  function beep() {
    ensureCtx();
    var now = ctx.currentTime;
    var dur = 0.28;
    [880, 1320].forEach(function(freq, i) {
      var osc  = ctx.createOscillator();
      var gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);
      osc.type = 'square';
      osc.frequency.value = freq;
      gain.gain.setValueAtTime(i === 0 ? 0.6 : 0.4, now);
      gain.gain.exponentialRampToValueAtTime(0.001, now + dur);
      osc.start(now);
      osc.stop(now + dur);
    });
  }

  function startAlarm() { if (!timer) { beep(); timer = setInterval(beep, 600); } }
  function stopAlarm()  {
    if (timer) { clearInterval(timer); timer = null; }
    if (ctx)   { try { ctx.suspend(); } catch(e) {} }
  }

  document.addEventListener('message', function(e) {
    if (e.data === 'start') startAlarm();
    if (e.data === 'stop')  stopAlarm();
  });
  window.addEventListener('message', function(e) {
    if (e.data === 'start') startAlarm();
    if (e.data === 'stop')  stopAlarm();
  });
<\/script>
</body>
</html>`;

// ─── Component ───────────────────────────────────────────────────────────────

export default function MonitorScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();

  const [isMonitoring, setIsMonitoring]     = useState(false);
  const [targetMobile, setTargetMobile]     = useState(DEFAULT_MOBILE_NUMBER);
  const [position, setPosition]             = useState<number | null>(null);
  const [frontMobile, setFrontMobile]       = useState<number | null>(null);
  const [behindMobile, setBehindMobile]     = useState<number | null>(null);
  const [totalInQueue, setTotalInQueue]     = useState<number>(0);
  const [threshold, setThreshold]           = useState<number>(6);
  const [thresholdInput, setThresholdInput] = useState<string>('6');
  const [alarmActive, setAlarmActive]       = useState(false);
  const [lastUpdate, setLastUpdate]         = useState<Date | null>(null);
  const [error, setError]                   = useState<string | null>(null);
  const [isLoading, setIsLoading]           = useState(false);
  const [notifGranted, setNotifGranted]     = useState(false);
  const [bgTaskActive, setBgTaskActive]     = useState(false);

  const intervalRef    = useRef<ReturnType<typeof setInterval> | null>(null);
  const webViewRef     = useRef<WebView | null>(null);
  const targetMobileRef = useRef(targetMobile);
  const thresholdRef   = useRef(threshold);
  const alarmActiveRef = useRef(false);

  useEffect(() => { targetMobileRef.current = targetMobile; }, [targetMobile]);
  useEffect(() => { thresholdRef.current = threshold; }, [threshold]);
  useEffect(() => { alarmActiveRef.current = alarmActive; }, [alarmActive]);

  // ── Load persisted threshold ──
  useEffect(() => {
    AsyncStorage.getItem(THRESHOLD_KEY).then((val) => {
      if (val !== null) {
        const n = parseInt(val, 10);
        if (!isNaN(n) && n >= 1) {
          setThreshold(n);
          setThresholdInput(String(n));
        }
      }
    });
  }, []);

  // Refresh the saved mobile number when returning from Settings.
  useFocusEffect(
    useCallback(() => {
      let isFocused = true;
      AsyncStorage.getItem(MOBILE_NUMBER_KEY)
        .then((value) => {
          const mobile = value ? Number.parseInt(value, 10) : DEFAULT_MOBILE_NUMBER;
          if (isFocused && Number.isSafeInteger(mobile) && mobile > 0) {
            setTargetMobile(mobile);
          }
        })
        .catch((e) => console.warn('[Monitor] Could not load mobile number:', e));
      return () => {
        isFocused = false;
      };
    }, []),
  );

  // ── Request notification permissions on mount ──
  useEffect(() => {
    (async () => {
      const { status: existing } = await Notifications.getPermissionsAsync();
      if (existing === 'granted') {
        setNotifGranted(true);
        return;
      }
      const { status } = await Notifications.requestPermissionsAsync({
        ios: {
          allowAlert:  true,
          allowSound:  true,
          allowBadge:  false,
          allowCriticalAlerts: true,
        },
      });
      if (status === 'granted') {
        setNotifGranted(true);
      } else {
        Alert.alert(
          'Notificaciones desactivadas',
          'La alarma sonará solo mientras la app está abierta. Para recibir alertas con pantalla apagada, habilita las notificaciones en Configuración.',
          [{ text: 'Entendido' }],
        );
      }
    })();
  }, []);

  // ── Alarm animation ──
  const alarmOpacity = useSharedValue(1);
  useEffect(() => {
    if (alarmActive) {
      alarmOpacity.value = withRepeat(
        withSequence(
          withTiming(0.25, { duration: 350 }),
          withTiming(1,    { duration: 350 }),
        ),
        -1,
        false,
      );
    } else {
      cancelAnimation(alarmOpacity);
      alarmOpacity.value = withTiming(1, { duration: 200 });
    }
  }, [alarmActive]);

  const alarmBannerStyle = useAnimatedStyle(() => ({
    opacity: alarmOpacity.value,
  }));

  // ── WebView audio helpers ──
  const sendToWebView = useCallback((cmd: 'start' | 'stop') => {
    if (Platform.OS === 'web' || !webViewRef.current) return;
    webViewRef.current.injectJavaScript(
      cmd === 'start' ? 'startAlarm(); true;' : 'stopAlarm(); true;',
    );
  }, []);

  const startAlarmSound = useCallback(() => sendToWebView('start'), [sendToWebView]);
  const stopAlarmSound  = useCallback(() => sendToWebView('stop'),  [sendToWebView]);

  useEffect(() => () => { stopAlarmSound(); }, []);

  const stopAlarm = useCallback(async () => {
    alarmActiveRef.current = false;
    setAlarmActive(false);
    stopAlarmSound();
    // Dismiss the persistent notification if it was fired
    await Notifications.dismissAllNotificationsAsync();
    await resetAlertState();
    Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
  }, [stopAlarmSound]);

  // ── Fetch + parse ──
  const fetchAndCheck = useCallback(async () => {
    try {
      setIsLoading(true);
      setError(null);
      const resp = await fetch(POLL_URL, { method: 'POST' });
      if (!resp.ok) throw new Error(`Error HTTP ${resp.status}`);
      const html      = await resp.text();
      const entries   = parseQueueHTML(html);
      setTotalInQueue(entries.length);
      setLastUpdate(new Date());
      const targetIndex = entries.findIndex((e) => e.mobile === targetMobileRef.current);
      const target      = targetIndex >= 0 ? entries[targetIndex] : undefined;
      const targetPos = target?.position ?? null;
      setPosition(targetPos);
      setFrontMobile(targetIndex > 0 ? entries[targetIndex - 1].mobile : null);
      setBehindMobile(
        targetIndex >= 0 && targetIndex < entries.length - 1
          ? entries[targetIndex + 1].mobile
          : null,
      );

      if (
        targetPos !== null &&
        targetPos <= thresholdRef.current &&
        !alarmActiveRef.current
      ) {
        alarmActiveRef.current = true;
        setAlarmActive(true);
        Haptics.notificationAsync(Haptics.NotificationFeedbackType.Warning);
        // In-app audio beeper (works while screen is on)
        startAlarmSound();
        // Local notification so the alarm persists even if screen turns off
        if (notifGranted) {
          fireAlarmNotification(targetPos, thresholdRef.current, targetMobileRef.current);
        }
      }
    } catch (err: unknown) {
      setError(err instanceof Error ? err.message : 'Error desconocido');
    } finally {
      setIsLoading(false);
    }
  }, [startAlarmSound, notifGranted]);

  const fetchRef = useRef(fetchAndCheck);
  useEffect(() => { fetchRef.current = fetchAndCheck; }, [fetchAndCheck]);

  // Refresh the displayed position immediately if Settings changes the mobile.
  const previousMobileRef = useRef(targetMobile);
  useEffect(() => {
    if (previousMobileRef.current === targetMobile) return;
    previousMobileRef.current = targetMobile;
    setPosition(null);
    setFrontMobile(null);
    setBehindMobile(null);
    if (alarmActiveRef.current) {
      alarmActiveRef.current = false;
      setAlarmActive(false);
      stopAlarmSound();
      Notifications.dismissAllNotificationsAsync().catch(() => {});
    }
    if (isMonitoring) fetchRef.current();
  }, [targetMobile, isMonitoring, stopAlarmSound]);

  // ── Start monitoring ──
  const startMonitoring = useCallback(async () => {
    setIsMonitoring(true);
    await fetchRef.current();
    intervalRef.current = setInterval(() => fetchRef.current(), POLL_INTERVAL_MS);
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Medium);

    // Register background fetch (best-effort; OS controls actual interval ~15 min)
    const ok = await registerBackgroundMonitor();
    setBgTaskActive(ok);
  }, []);

  // ── Stop monitoring ──
  const stopMonitoring = useCallback(async () => {
    setIsMonitoring(false);
    if (intervalRef.current) {
      clearInterval(intervalRef.current);
      intervalRef.current = null;
    }
    await stopAlarm();
    await unregisterBackgroundMonitor();
    setBgTaskActive(false);
  }, [stopAlarm]);

  useEffect(() => () => {
    if (intervalRef.current) clearInterval(intervalRef.current);
  }, []);

  // ── Threshold controls ──
  const handleThresholdStep = useCallback(
    (delta: number) => {
      const next = Math.max(1, threshold + delta);
      setThreshold(next);
      setThresholdInput(String(next));
      AsyncStorage.setItem(THRESHOLD_KEY, String(next));
      Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    },
    [threshold],
  );

  const handleThresholdInput = useCallback((text: string) => {
    setThresholdInput(text);
    const n = parseInt(text, 10);
    if (!isNaN(n) && n >= 1) {
      setThreshold(n);
      AsyncStorage.setItem(THRESHOLD_KEY, String(n));
    }
  }, []);

  // ── Derived display values ──
  const positionColor = alarmActive
    ? colors.destructive
    : position !== null && position <= threshold
      ? colors.accent
      : colors.primary;

  const formatTime = (d: Date) =>
    d.toLocaleTimeString('es-UY', {
      hour:   '2-digit',
      minute: '2-digit',
      second: '2-digit',
    });

  const s = useMemo(() => makeStyles(colors), [colors]);
  const webPadTop = Platform.OS === 'web' ? 67 : 0;
  const webPadBot = Platform.OS === 'web' ? 34 : 0;

  return (
    <View
      style={[
        s.root,
        {
          paddingTop:    insets.top + webPadTop,
          paddingBottom: insets.bottom + webPadBot,
        },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      {/* ── Hidden WebView — synthetic audio engine ── */}
      {Platform.OS !== 'web' && (
        <WebView
          ref={webViewRef}
          source={{ html: ALARM_HTML }}
          style={s.hiddenWebView}
          javaScriptEnabled
          mediaPlaybackRequiresUserAction={false}
          allowsInlineMediaPlayback
        />
      )}

      {/* ── Alarm banner ── */}
      {alarmActive && (
        <Animated.View style={[s.alarmBanner, alarmBannerStyle]}>
          <View style={s.alarmLeft}>
            <Ionicons name="warning" size={22} color="#FFFFFF" />
            <Text style={s.alarmTitle}>MÓVIL {targetMobile} EN POSICIÓN {position}</Text>
          </View>
          <TouchableOpacity style={s.stopAlarmBtn} onPress={stopAlarm} activeOpacity={0.8}>
            <Ionicons name="stop-circle" size={18} color="#FFFFFF" />
            <Text style={s.stopAlarmLabel}>DETENER</Text>
          </TouchableOpacity>
        </Animated.View>
      )}

      {/* ── Header ── */}
      <View style={s.header}>
        <Text style={s.appName}>FILA TAXIS</Text>
        <View style={s.headerActions}>
          <View style={s.statusPill}>
            <View
              style={[
                s.statusDot,
                { backgroundColor: isMonitoring ? colors.success : colors.mutedForeground },
              ]}
            />
            <Text
              style={[
                s.statusLabel,
                { color: isMonitoring ? colors.success : colors.mutedForeground },
              ]}
            >
              {isMonitoring ? 'ACTIVO' : 'DETENIDO'}
            </Text>
          </View>
          <TouchableOpacity
            style={s.settingsBtn}
            onPress={() => router.push('/settings')}
            activeOpacity={0.7}
            accessibilityRole="button"
            accessibilityLabel="Configuración"
          >
            <Ionicons name="settings-outline" size={20} color={colors.foreground} />
          </TouchableOpacity>
        </View>
      </View>

      {/* ── Position card ── */}
      <View style={s.posCard}>
        <Text style={[s.posNumber, { color: positionColor }]}>
          {position !== null ? String(position) : '—'}
        </Text>
        <Text style={s.posLabel}>POSICIÓN MÓVIL {targetMobile}</Text>
        {isLoading && (
          <ActivityIndicator
            size="small"
            color={colors.mutedForeground}
            style={s.loadingIndicator}
          />
        )}
      </View>

      {/* ── Queue neighbors ── */}
      <View style={s.neighborsCard}>
        <View style={s.neighborCell}>
          <Ionicons name="arrow-up" size={17} color={colors.mutedForeground} />
          <View style={s.neighborText}>
            <Text style={s.neighborLabel}>DELANTE</Text>
            <Text style={s.neighborMobile}>
              {frontMobile !== null ? `Móvil ${frontMobile}` : '—'}
            </Text>
            <Text style={s.neighborPosition}>
              {position !== null && frontMobile !== null
                ? `Posición ${position - 1}`
                : 'Sin móvil'}
            </Text>
          </View>
        </View>
        <View style={s.neighborDivider} />
        <View style={s.neighborCell}>
          <Ionicons name="arrow-down" size={17} color={colors.mutedForeground} />
          <View style={s.neighborText}>
            <Text style={s.neighborLabel}>DETRÁS</Text>
            <Text style={s.neighborMobile}>
              {behindMobile !== null ? `Móvil ${behindMobile}` : '—'}
            </Text>
            <Text style={s.neighborPosition}>
              {position !== null && behindMobile !== null
                ? `Posición ${position + 1}`
                : 'Sin móvil'}
            </Text>
          </View>
        </View>
      </View>

      {/* ── Stats ── */}
      <View style={s.statsRow}>
        <View style={s.statCell}>
          <Text style={s.statVal}>{totalInQueue}</Text>
          <Text style={s.statKey}>EN FILA</Text>
        </View>
        <View style={s.statSep} />
        <View style={s.statCell}>
          <Text style={s.statVal}>{threshold}</Text>
          <Text style={s.statKey}>UMBRAL</Text>
        </View>
        <View style={s.statSep} />
        <View style={s.statCell}>
          <Text style={s.statVal}>30s</Text>
          <Text style={s.statKey}>INTERVALO</Text>
        </View>
      </View>

      {/* ── Last update ── */}
      {lastUpdate ? (
        <Text style={s.lastUpdate}>Actualizado: {formatTime(lastUpdate)}</Text>
      ) : (
        <Text style={s.lastUpdate}>Sin datos aún</Text>
      )}

      {/* ── Error ── */}
      {error && (
        <View style={s.errorBox}>
          <Ionicons name="alert-circle-outline" size={15} color={colors.destructive} />
          <Text style={s.errorText} numberOfLines={2}>{error}</Text>
        </View>
      )}

      {/* ── Background task status ── */}
      {isMonitoring && (
        <View style={s.bgStatusRow}>
          <Ionicons
            name={bgTaskActive ? 'shield-checkmark-outline' : 'shield-outline'}
            size={13}
            color={bgTaskActive ? colors.success : colors.mutedForeground}
          />
          <Text
            style={[
              s.bgStatusText,
              { color: bgTaskActive ? colors.success : colors.mutedForeground },
            ]}
          >
            {bgTaskActive
              ? 'Alerta en segundo plano activa (~15 min)'
              : 'Sin alerta en segundo plano'}
          </Text>
        </View>
      )}

      {/* ── Threshold control ── */}
      <View style={s.threshCard}>
        <Text style={s.threshTitle}>Umbral de alerta</Text>
        <View style={s.threshRow}>
          <TouchableOpacity
            style={s.threshBtn}
            onPress={() => handleThresholdStep(-1)}
            disabled={threshold <= 1}
            activeOpacity={0.7}
          >
            <Ionicons
              name="remove"
              size={22}
              color={threshold <= 1 ? colors.mutedForeground : colors.foreground}
            />
          </TouchableOpacity>
          <TextInput
            style={s.threshInput}
            value={thresholdInput}
            onChangeText={handleThresholdInput}
            keyboardType="number-pad"
            maxLength={2}
            selectTextOnFocus
          />
          <TouchableOpacity
            style={s.threshBtn}
            onPress={() => handleThresholdStep(1)}
            activeOpacity={0.7}
          >
            <Ionicons name="add" size={22} color={colors.foreground} />
          </TouchableOpacity>
        </View>
        <Text style={s.threshHint}>Alarma cuando posición ≤ {threshold}</Text>
      </View>

      {/* ── Control button ── */}
      <TouchableOpacity
        style={[
          s.ctrlBtn,
          { backgroundColor: isMonitoring ? colors.destructive : colors.primary },
        ]}
        onPress={isMonitoring ? stopMonitoring : startMonitoring}
        activeOpacity={0.82}
      >
        <Ionicons
          name={isMonitoring ? 'stop' : 'play'}
          size={20}
          color={isMonitoring ? colors.destructiveForeground : colors.primaryForeground}
        />
        <Text
          style={[
            s.ctrlLabel,
            {
              color: isMonitoring
                ? colors.destructiveForeground
                : colors.primaryForeground,
            },
          ]}
        >
          {isMonitoring ? 'DETENER MONITOR' : 'INICIAR MONITOR'}
        </Text>
      </TouchableOpacity>
    </View>
  );
}

// ─── Styles factory ───────────────────────────────────────────────────────────

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 20,
    },
    hiddenWebView: {
      width: 0,
      height: 0,
      position: 'absolute',
      opacity: 0,
    },
    alarmBanner: {
      backgroundColor: colors.destructive,
      borderRadius: colors.radius,
      paddingHorizontal: 16,
      paddingVertical: 12,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 10,
      marginTop: 6,
    },
    alarmLeft: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      flex: 1,
    },
    alarmTitle: {
      color: '#FFFFFF',
      fontFamily: 'Inter_700Bold',
      fontSize: 13,
      letterSpacing: 0.5,
      flexShrink: 1,
    },
    stopAlarmBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 4,
      backgroundColor: 'rgba(0,0,0,0.25)',
      borderRadius: 8,
      paddingHorizontal: 10,
      paddingVertical: 6,
    },
    stopAlarmLabel: {
      color: '#FFFFFF',
      fontFamily: 'Inter_600SemiBold',
      fontSize: 12,
      letterSpacing: 0.8,
    },
    header: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginTop: 12,
      marginBottom: 20,
    },
    headerActions: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
    },
    settingsBtn: {
      width: 38,
      height: 38,
      borderRadius: 19,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
    },
    appName: {
      color: colors.primary,
      fontFamily: 'Inter_700Bold',
      fontSize: 22,
      letterSpacing: 3,
    },
    statusPill: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: colors.card,
      paddingHorizontal: 12,
      paddingVertical: 6,
      borderRadius: 99,
      borderWidth: 1,
      borderColor: colors.border,
    },
    statusDot: {
      width: 7,
      height: 7,
      borderRadius: 4,
    },
    statusLabel: {
      fontFamily: 'Inter_600SemiBold',
      fontSize: 11,
      letterSpacing: 1.2,
    },
    posCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      paddingVertical: 32,
      alignItems: 'center',
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 16,
    },
    neighborsCard: {
      flexDirection: 'row',
      alignItems: 'center',
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 12,
      paddingVertical: 12,
      paddingHorizontal: 14,
    },
    neighborCell: {
      flex: 1,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 8,
    },
    neighborText: {
      alignItems: 'center',
    },
    neighborLabel: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_600SemiBold',
      fontSize: 10,
      letterSpacing: 1.4,
    },
    neighborMobile: {
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      fontSize: 15,
      marginTop: 2,
    },
    neighborPosition: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 10,
      marginTop: 1,
    },
    neighborDivider: {
      width: 1,
      alignSelf: 'stretch',
      backgroundColor: colors.border,
      marginHorizontal: 8,
    },
    posNumber: {
      fontFamily: 'Inter_700Bold',
      fontSize: 88,
      lineHeight: 96,
      letterSpacing: -4,
    },
    posLabel: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_500Medium',
      fontSize: 12,
      letterSpacing: 2.5,
      marginTop: 4,
    },
    loadingIndicator: {
      marginTop: 10,
    },
    statsRow: {
      flexDirection: 'row',
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      marginBottom: 10,
      overflow: 'hidden',
    },
    statCell: {
      flex: 1,
      alignItems: 'center',
      paddingVertical: 14,
    },
    statSep: {
      width: 1,
      backgroundColor: colors.border,
      marginVertical: 10,
    },
    statVal: {
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      fontSize: 20,
      letterSpacing: -0.5,
    },
    statKey: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_500Medium',
      fontSize: 10,
      letterSpacing: 1.5,
      marginTop: 2,
    },
    lastUpdate: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 12,
      textAlign: 'center',
      marginBottom: 6,
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 6,
      backgroundColor: `${colors.destructive}18`,
      borderRadius: 8,
      paddingHorizontal: 12,
      paddingVertical: 8,
      marginBottom: 8,
      borderWidth: 1,
      borderColor: `${colors.destructive}40`,
    },
    errorText: {
      color: colors.destructive,
      fontFamily: 'Inter_400Regular',
      fontSize: 12,
      flex: 1,
    },
    bgStatusRow: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 5,
      justifyContent: 'center',
      marginBottom: 8,
    },
    bgStatusText: {
      fontFamily: 'Inter_400Regular',
      fontSize: 11,
      letterSpacing: 0.3,
    },
    threshCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingVertical: 16,
      paddingHorizontal: 20,
      marginBottom: 14,
    },
    threshTitle: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_500Medium',
      fontSize: 11,
      letterSpacing: 2,
      textAlign: 'center',
      marginBottom: 12,
    },
    threshRow: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 16,
    },
    threshBtn: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.secondary,
      alignItems: 'center',
      justifyContent: 'center',
    },
    threshInput: {
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      fontSize: 32,
      letterSpacing: -1,
      textAlign: 'center',
      width: 72,
    },
    threshHint: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 12,
      textAlign: 'center',
      marginTop: 10,
    },
    ctrlBtn: {
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      borderRadius: colors.radius,
      paddingVertical: 18,
    },
    ctrlLabel: {
      fontFamily: 'Inter_700Bold',
      fontSize: 15,
      letterSpacing: 2,
    },
  });
}
