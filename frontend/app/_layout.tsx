import { useEffect } from 'react';
import { Stack, useRouter } from 'expo-router';
import { StatusBar } from 'expo-status-bar';
import { Platform } from 'react-native';
import * as Linking from 'expo-linking';
import { ToastProvider } from '../components/Toast';
import { addToClipboard } from '../lib/clipboard';

// ---------------------------------------------------------------------------
// Helpers – extract video URLs from incoming intents / deep links
// ---------------------------------------------------------------------------

/** Regex to find Instagram or TikTok URLs in arbitrary text */
const VIDEO_URL_RE =
  /https?:\/\/(?:www\.)?(?:instagram\.com\/(?:reel|p)\/[\w-]+|tiktok\.com\/@[\w.]+\/video\/\d+|vm\.tiktok\.com\/[\w-]+|vt\.tiktok\.com\/[\w-]+)/gi;

/**
 * Given a URL or text blob that was shared into the app,
 * extract every Instagram / TikTok URL, save them to the clipboard,
 * and navigate to the share screen.
 */
async function handleIncomingUrl(
  urlOrText: string | null | undefined,
  router: ReturnType<typeof useRouter>,
) {
  if (!urlOrText) return;

  const matches = urlOrText.match(VIDEO_URL_RE);
  if (!matches || matches.length === 0) return;

  // Deduplicate
  const unique = [...new Set(matches)];

  for (const url of unique) {
    await addToClipboard(url);
  }

  // Navigate to the share / media-inbox screen
  router.push('/share');
}

// ---------------------------------------------------------------------------
// Root Layout
// ---------------------------------------------------------------------------

export default function RootLayout() {
  const router = useRouter();

  // ── Handle deep links & shared intents ──────────────────────
  useEffect(() => {
    // 1) Cold start – app was opened via a link / share intent
    (async () => {
      const initialUrl = await Linking.getInitialURL();
      await handleIncomingUrl(initialUrl, router);
    })();

    // 2) Warm resume – app is already running and receives a new URL
    const subscription = Linking.addEventListener('url', (event) => {
      handleIncomingUrl(event.url, router);
    });

    return () => subscription.remove();
  }, [router]);

  return (
    <ToastProvider>
      <StatusBar style="light" />
      <Stack
        screenOptions={{
          headerStyle: {
            backgroundColor: '#0A0A0F',
          },
          headerTintColor: '#fff',
          headerTitleStyle: {
            fontWeight: 'bold',
          },
          contentStyle: {
            backgroundColor: '#0A0A0F',
          },
        }}
      >
        <Stack.Screen 
          name="index" 
          options={{ title: 'WhoSharedThisVideo?', headerShown: false }} 
        />
        <Stack.Screen 
          name="room/[id]/index" 
          options={{ title: 'Lobby', headerBackVisible: true }} 
        />
        <Stack.Screen 
          name="room/[id]/game" 
          options={{ title: 'Game', headerShown: false, gestureEnabled: false }} 
        />
        <Stack.Screen 
          name="room/[id]/results" 
          options={{ title: 'Results', headerBackVisible: false, gestureEnabled: false }} 
        />
        <Stack.Screen 
          name="share" 
          options={{ title: 'Media Inbox', headerShown: false }} 
        />
      </Stack>
    </ToastProvider>
  );
}
