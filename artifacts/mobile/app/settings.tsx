import React, { useEffect, useMemo, useState } from 'react';
import {
  Keyboard,
  StatusBar,
  StyleSheet,
  Text,
  TextInput,
  TouchableOpacity,
  View,
} from 'react-native';
import { useRouter } from 'expo-router';
import { Ionicons } from '@expo/vector-icons';
import AsyncStorage from '@react-native-async-storage/async-storage';
import * as Haptics from 'expo-haptics';
import { useSafeAreaInsets } from 'react-native-safe-area-context';
import { useColors } from '@/hooks/useColors';
import { DEFAULT_MOBILE_NUMBER, MOBILE_NUMBER_KEY } from '@/constants/monitor';
import { resetAlertState } from '@/tasks/backgroundMonitor';
import * as Notifications from 'expo-notifications';

export default function SettingsScreen() {
  const colors = useColors();
  const insets = useSafeAreaInsets();
  const router = useRouter();
  const [mobileInput, setMobileInput] = useState(String(DEFAULT_MOBILE_NUMBER));
  const [savedMobile, setSavedMobile] = useState(DEFAULT_MOBILE_NUMBER);
  const [error, setError] = useState<string | null>(null);
  const [isSaving, setIsSaving] = useState(false);
  const styles = useMemo(() => makeStyles(colors), [colors]);

  useEffect(() => {
    AsyncStorage.getItem(MOBILE_NUMBER_KEY)
      .then((value) => {
        if (!value) return;
        const mobile = Number.parseInt(value, 10);
        if (Number.isSafeInteger(mobile) && mobile > 0) {
          setSavedMobile(mobile);
          setMobileInput(String(mobile));
        }
      })
      .catch(() => setError('No se pudo cargar la configuración.'));
  }, []);

  const saveMobile = async () => {
    Keyboard.dismiss();
    const value = mobileInput.trim();
    if (!/^\d+$/.test(value) || Number(value) < 1) {
      setError('Ingresa un número de móvil válido, mayor que 0.');
      return;
    }

    const mobile = Number(value);
    if (!Number.isSafeInteger(mobile)) {
      setError('El número ingresado no es válido.');
      return;
    }

    setIsSaving(true);
    setError(null);
    try {
      await AsyncStorage.setItem(MOBILE_NUMBER_KEY, String(mobile));
      if (mobile !== savedMobile) {
        await resetAlertState();
        await Notifications.dismissAllNotificationsAsync();
      }
      setSavedMobile(mobile);
      setMobileInput(String(mobile));
      Haptics.notificationAsync(Haptics.NotificationFeedbackType.Success);
      router.back();
    } catch {
      setError('No se pudo guardar el número. Inténtalo de nuevo.');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <View
      style={[
        styles.root,
        { paddingTop: insets.top, paddingBottom: insets.bottom + 20 },
      ]}
    >
      <StatusBar barStyle="light-content" backgroundColor={colors.background} />

      <View style={styles.header}>
        <TouchableOpacity
          style={styles.backButton}
          onPress={() => router.back()}
          accessibilityRole="button"
          accessibilityLabel="Volver"
        >
          <Ionicons name="arrow-back" size={22} color={colors.foreground} />
        </TouchableOpacity>
        <Text style={styles.headerTitle}>CONFIGURACIÓN</Text>
        <View style={styles.headerSpacer} />
      </View>

      <View style={styles.content}>
        <View style={styles.iconCircle}>
          <Ionicons name="car-sport-outline" size={28} color={colors.primary} />
        </View>
        <Text style={styles.title}>Tu móvil</Text>
        <Text style={styles.description}>
          Ingresa el número que aparece en la fila. La alarma seguirá a este móvil
          tanto con la app abierta como en segundo plano.
        </Text>

        <View style={styles.fieldCard}>
          <Text style={styles.fieldLabel}>NÚMERO DE MÓVIL</Text>
          <TextInput
            style={styles.mobileInput}
            value={mobileInput}
            onChangeText={(text) => {
              setMobileInput(text.replace(/\D/g, ''));
              setError(null);
            }}
            keyboardType="number-pad"
            maxLength={8}
            placeholder="10"
            placeholderTextColor={colors.mutedForeground}
            selectTextOnFocus
            accessibilityLabel="Número de móvil"
            returnKeyType="done"
            onSubmitEditing={saveMobile}
          />
          <Text style={styles.savedHint}>
            {savedMobile === DEFAULT_MOBILE_NUMBER
              ? 'Predeterminado: móvil 10'
              : `Guardado actualmente: móvil ${savedMobile}`}
          </Text>
        </View>

        {error && (
          <View style={styles.errorBox}>
            <Ionicons name="alert-circle-outline" size={17} color={colors.destructive} />
            <Text style={styles.errorText}>{error}</Text>
          </View>
        )}

        <TouchableOpacity
          style={[styles.saveButton, isSaving && styles.saveButtonDisabled]}
          onPress={saveMobile}
          disabled={isSaving}
          activeOpacity={0.82}
          accessibilityRole="button"
        >
          <Ionicons name="save-outline" size={19} color={colors.primaryForeground} />
          <Text style={styles.saveButtonLabel}>
            {isSaving ? 'GUARDANDO…' : 'GUARDAR CONFIGURACIÓN'}
          </Text>
        </TouchableOpacity>
      </View>

      <Text style={styles.footerNote}>
        Esta preferencia se guarda en este teléfono y podrás cambiarla en cualquier
        momento desde el botón de configuración.
      </Text>
    </View>
  );
}

function makeStyles(colors: ReturnType<typeof useColors>) {
  return StyleSheet.create({
    root: {
      flex: 1,
      backgroundColor: colors.background,
      paddingHorizontal: 20,
    },
    header: {
      minHeight: 52,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'space-between',
      marginBottom: 22,
    },
    backButton: {
      width: 44,
      height: 44,
      borderRadius: 22,
      backgroundColor: colors.card,
      alignItems: 'center',
      justifyContent: 'center',
      borderWidth: 1,
      borderColor: colors.border,
    },
    headerTitle: {
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      fontSize: 13,
      letterSpacing: 2,
    },
    headerSpacer: {
      width: 44,
      height: 44,
    },
    content: {
      flex: 1,
      justifyContent: 'center',
    },
    iconCircle: {
      width: 64,
      height: 64,
      borderRadius: 32,
      backgroundColor: colors.card,
      borderWidth: 1,
      borderColor: colors.border,
      alignItems: 'center',
      justifyContent: 'center',
      alignSelf: 'center',
      marginBottom: 18,
    },
    title: {
      color: colors.foreground,
      fontFamily: 'Inter_700Bold',
      fontSize: 26,
      textAlign: 'center',
      marginBottom: 8,
    },
    description: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 14,
      lineHeight: 21,
      textAlign: 'center',
      marginBottom: 26,
      paddingHorizontal: 4,
    },
    fieldCard: {
      backgroundColor: colors.card,
      borderRadius: colors.radius,
      borderWidth: 1,
      borderColor: colors.border,
      paddingHorizontal: 20,
      paddingVertical: 18,
      alignItems: 'center',
      marginBottom: 14,
    },
    fieldLabel: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_500Medium',
      fontSize: 11,
      letterSpacing: 1.8,
      marginBottom: 8,
    },
    mobileInput: {
      minWidth: 110,
      color: colors.primary,
      fontFamily: 'Inter_700Bold',
      fontSize: 42,
      textAlign: 'center',
      paddingVertical: 2,
    },
    savedHint: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 12,
      textAlign: 'center',
      marginTop: 8,
    },
    errorBox: {
      flexDirection: 'row',
      alignItems: 'center',
      gap: 8,
      backgroundColor: `${colors.destructive}18`,
      borderRadius: 8,
      borderWidth: 1,
      borderColor: `${colors.destructive}40`,
      paddingHorizontal: 12,
      paddingVertical: 10,
      marginBottom: 14,
    },
    errorText: {
      color: colors.destructive,
      fontFamily: 'Inter_400Regular',
      fontSize: 13,
      flex: 1,
    },
    saveButton: {
      minHeight: 56,
      flexDirection: 'row',
      alignItems: 'center',
      justifyContent: 'center',
      gap: 10,
      backgroundColor: colors.primary,
      borderRadius: colors.radius,
      paddingHorizontal: 16,
      paddingVertical: 16,
    },
    saveButtonDisabled: {
      opacity: 0.6,
    },
    saveButtonLabel: {
      color: colors.primaryForeground,
      fontFamily: 'Inter_700Bold',
      fontSize: 13,
      letterSpacing: 1,
    },
    footerNote: {
      color: colors.mutedForeground,
      fontFamily: 'Inter_400Regular',
      fontSize: 12,
      lineHeight: 18,
      textAlign: 'center',
      paddingHorizontal: 12,
      marginTop: 12,
    },
  });
}
