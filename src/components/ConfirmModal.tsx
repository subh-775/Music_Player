/**
 * An in-app confirm dialog styled like the rest of the app — replacing the
 * stock `Alert.alert`, which renders in the OS's own grey window and looks
 * nothing like the product. Fades + scales in over a scrim (200ms, Product
 * register). `danger` tints the confirm button red for destructive actions.
 */
import React, {useEffect, useRef} from 'react';
import {
  Animated,
  Modal,
  StyleSheet,
  Text,
  TouchableOpacity,
  View,
} from 'react-native';
import {C} from '../theme';

export function ConfirmModal({
  visible,
  title,
  message,
  confirmLabel = 'Confirm',
  cancelLabel = 'Cancel',
  danger,
  onConfirm,
  onCancel,
}: {
  visible: boolean;
  title: string;
  message?: string;
  confirmLabel?: string;
  cancelLabel?: string;
  danger?: boolean;
  onConfirm: () => void;
  onCancel: () => void;
}) {
  const a = useRef(new Animated.Value(0)).current;

  useEffect(() => {
    Animated.timing(a, {
      toValue: visible ? 1 : 0,
      duration: visible ? 180 : 120,
      useNativeDriver: true,
    }).start();
  }, [visible, a]);

  return (
    <Modal
      visible={visible}
      transparent
      animationType="none"
      onRequestClose={onCancel}
      statusBarTranslucent>
      <Animated.View style={[styles.scrim, {opacity: a}]}>
        <TouchableOpacity
          style={StyleSheet.absoluteFill}
          activeOpacity={1}
          onPress={onCancel}
        />
        <Animated.View
          style={[
            styles.card,
            {
              opacity: a,
              transform: [
                {scale: a.interpolate({inputRange: [0, 1], outputRange: [0.94, 1]})},
              ],
            },
          ]}>
          <Text style={styles.title}>{title}</Text>
          {!!message && <Text style={styles.message}>{message}</Text>}
          <View style={styles.actions}>
            <TouchableOpacity
              style={[styles.btn, styles.cancel]}
              activeOpacity={0.7}
              onPress={onCancel}>
              <Text style={styles.cancelText}>{cancelLabel}</Text>
            </TouchableOpacity>
            <TouchableOpacity
              style={[styles.btn, danger ? styles.confirmDanger : styles.confirm]}
              activeOpacity={0.85}
              onPress={onConfirm}>
              <Text style={danger ? styles.confirmDangerText : styles.confirmText}>
                {confirmLabel}
              </Text>
            </TouchableOpacity>
          </View>
        </Animated.View>
      </Animated.View>
    </Modal>
  );
}

const styles = StyleSheet.create({
  scrim: {
    flex: 1,
    backgroundColor: 'rgba(0,0,0,0.6)',
    alignItems: 'center',
    justifyContent: 'center',
    paddingHorizontal: 36,
  },
  card: {
    width: '100%',
    maxWidth: 360,
    backgroundColor: C.surfaceHi,
    borderRadius: 16,
    padding: 22,
    borderWidth: StyleSheet.hairlineWidth,
    borderColor: C.border,
  },
  title: {color: C.text, fontSize: 18, fontWeight: '800', letterSpacing: 0.1},
  message: {color: C.sub, fontSize: 13.5, lineHeight: 20, marginTop: 10},
  actions: {flexDirection: 'row', justifyContent: 'flex-end', gap: 10, marginTop: 22},
  btn: {
    paddingHorizontal: 18,
    paddingVertical: 10,
    borderRadius: 999,
    minWidth: 88,
    alignItems: 'center',
  },
  cancel: {backgroundColor: C.surface},
  cancelText: {color: C.text, fontWeight: '700', fontSize: 14},
  confirm: {backgroundColor: C.accent},
  confirmText: {color: C.bg, fontWeight: '800', fontSize: 14},
  confirmDanger: {backgroundColor: C.danger},
  confirmDangerText: {color: '#fff', fontWeight: '800', fontSize: 14},
});
