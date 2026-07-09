import { Colors } from '@/constants/theme';
import { useAppTheme } from '@/hooks/use-app-theme';

export function useTheme() {
  const { mode } = useAppTheme();

  return Colors[mode];
}
