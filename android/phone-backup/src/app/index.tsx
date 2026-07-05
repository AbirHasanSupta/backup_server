import { View, Text, Button } from 'react-native';
import { runSync } from '../../backgroundTask';

export default function Index() {
  return (
    <View>
      <Text>Phone Backup Running</Text>
      <Button title="Sync Now" onPress={() => runSync()} />
    </View>
  );
}