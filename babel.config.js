module.exports = {
  presets: ['module:@react-native/babel-preset'],
  // Reanimated's plugin rewrites worklets so they can run on the UI thread.
  // It MUST be listed last — it has to see the code after every other plugin
  // has transformed it, and the wrong order fails at runtime, not at build time.
  plugins: ['react-native-reanimated/plugin'],
};
