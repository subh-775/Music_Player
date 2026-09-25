// Types for lucide's per-icon files, which src/icons.ts imports directly. The
// package only types its index.
declare module 'lucide-react-native/dist/esm/icons/*' {
  import type {LucideIcon} from 'lucide-react-native';
  const Icon: LucideIcon;
  export default Icon;
}
