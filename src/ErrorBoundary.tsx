/**
 * Catches any render/runtime error in the React tree and shows a recovery screen
 * instead of a dead app. Without this, one thrown error in any screen unmounts
 * the whole UI to a blank (release) or red (debug) screen with no way back.
 */
import React from 'react';
import {StyleSheet, Text, TouchableOpacity, View} from 'react-native';

type Props = {children: React.ReactNode};
type State = {error: Error | null};

export class ErrorBoundary extends React.Component<Props, State> {
  state: State = {error: null};

  static getDerivedStateFromError(error: Error): State {
    return {error};
  }

  componentDidCatch(error: Error) {
    // Surfaces in `adb logcat` under ReactNativeJS for on-device debugging.
    console.error('Unhandled UI error:', error);
  }

  private reset = () => this.setState({error: null});

  render() {
    const {error} = this.state;
    if (!error) {
      return this.props.children;
    }
    return (
      <View style={styles.wrap}>
        <Text style={styles.title}>Something went wrong</Text>
        <Text style={styles.msg}>{error.message}</Text>
        <TouchableOpacity style={styles.btn} onPress={this.reset}>
          <Text style={styles.btnText}>Reload</Text>
        </TouchableOpacity>
      </View>
    );
  }
}

const styles = StyleSheet.create({
  wrap: {
    flex: 1,
    backgroundColor: '#0e0f13',
    alignItems: 'center',
    justifyContent: 'center',
    padding: 32,
    gap: 14,
  },
  title: {color: '#f2f3f5', fontSize: 18, fontWeight: '700'},
  msg: {color: '#8b8f9a', fontSize: 13, textAlign: 'center'},
  btn: {
    backgroundColor: '#f5a623',
    paddingHorizontal: 22,
    paddingVertical: 10,
    borderRadius: 999,
    marginTop: 6,
  },
  btnText: {color: '#0e0f13', fontWeight: '700'},
});
