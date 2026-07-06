import { Redirect } from 'expo-router';

// This route is no longer used. Redirect anyone who lands here to Home.
export default function Explore() {
  return <Redirect href="/" />;
}
