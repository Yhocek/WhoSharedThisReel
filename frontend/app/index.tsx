import React, { useState, useCallback } from 'react';
import {
  StyleSheet,
  Text,
  View,
  TextInput,
  TouchableOpacity,
  KeyboardAvoidingView,
  Platform,
  ActivityIndicator,
  Linking,
} from 'react-native';
import { useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api, { extractErrorMessage } from '../lib/api';
import { saveSession } from '../lib/session';
import { useToast } from '../components/Toast';

export default function HomeScreen() {
  const router = useRouter();
  const toast = useToast();
  const [displayName, setDisplayName] = useState('');
  const [roomCode, setRoomCode] = useState('');
  const [loading, setLoading] = useState(false);

  const handleCreateRoom = useCallback(async () => {
    const name = displayName.trim();
    if (!name) {
      toast.info('You need a display name to create a room.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/rooms', {
        display_name: name,
        max_players: 8,
      });

      const { room_id, room_code, player_id, session_token } = res.data;
      await saveSession(session_token, room_id, player_id);

      router.push(`/room/${room_id}`);
    } catch (error: any) {
      toast.error(extractErrorMessage(error.response?.data?.detail) || 'Failed to create room');
    } finally {
      setLoading(false);
    }
  }, [displayName, router]);

  const handleJoinRoom = useCallback(async () => {
    const name = displayName.trim();
    const code = roomCode.trim().replace(/[^0-9]/g, '');

    if (!name) {
      toast.info('You need a display name to join a room.');
      return;
    }
    if (code.length !== 6) {
      toast.info('Room codes are exactly 6 digits.');
      return;
    }

    setLoading(true);
    try {
      const res = await api.post('/rooms/join', {
        room_code: code,
        display_name: name,
      });

      const { room_id, player_id, session_token } = res.data;
      await saveSession(session_token, room_id, player_id);

      router.push(`/room/${room_id}`);
    } catch (error: any) {
      toast.error(extractErrorMessage(error.response?.data?.detail) || 'Failed to join room');
    } finally {
      setLoading(false);
    }
  }, [displayName, roomCode, router]);

  return (
    <View style={styles.container}>
      <SafeAreaView style={styles.safe}>
        <KeyboardAvoidingView
          style={styles.content}
          behavior={Platform.OS === 'ios' ? 'padding' : 'height'}
        >
          {/* Title */}
          <View style={styles.titleContainer}>
            <Text style={styles.emoji}>🎬</Text>
            <Text style={styles.title}>WhoShared</Text>
            <Text style={styles.titleAccent}>ThisVideo?</Text>
            <Text style={styles.subtitle}>The Video Sharing Party Game</Text>
          </View>

          {/* Card */}
          <View style={styles.card}>
            <Text style={styles.inputLabel}>YOUR NAME</Text>
            <TextInput
              style={styles.input}
              placeholder="e.g. Alex"
              placeholderTextColor="#666"
              value={displayName}
              onChangeText={setDisplayName}
              autoCapitalize="words"
              maxLength={30}
            />

            <View style={styles.divider} />

            <Text style={styles.inputLabel}>ROOM CODE</Text>
            <TextInput
              style={[styles.input, styles.codeInput]}
              placeholder="e.g. 123456"
              placeholderTextColor="#666"
              value={roomCode}
              onChangeText={(text) => setRoomCode(text.replace(/[^0-9]/g, ''))}
              keyboardType="numeric"
              maxLength={6}
            />

            <TouchableOpacity
              style={[styles.button, styles.buttonJoin]}
              onPress={handleJoinRoom}
              disabled={loading}
              activeOpacity={0.8}
            >
              {loading ? (
                <ActivityIndicator color="#fff" />
              ) : (
                <Text style={styles.buttonText}>Join Game</Text>
              )}
            </TouchableOpacity>

            <View style={styles.orRow}>
              <View style={styles.orLine} />
              <Text style={styles.orText}>OR</Text>
              <View style={styles.orLine} />
            </View>

            <TouchableOpacity
              style={[styles.button, styles.buttonCreate]}
              onPress={handleCreateRoom}
              disabled={loading}
              activeOpacity={0.8}
            >
              <Text style={styles.buttonTextCreate}>Create New Room</Text>
            </TouchableOpacity>
          </View>

          {/* Legal / Policy Footer */}
          <View style={styles.footerLinks}>
            <TouchableOpacity onPress={() => Linking.openURL('https://whosharedthisvideo-api.onrender.com/privacy')}>
              <Text style={styles.footerLinkText}>Privacy Policy</Text>
            </TouchableOpacity>
            <Text style={styles.footerLinkDivider}>•</Text>
            <TouchableOpacity onPress={() => Linking.openURL('https://whosharedthisvideo-api.onrender.com/terms')}>
              <Text style={styles.footerLinkText}>Terms of Service</Text>
            </TouchableOpacity>
          </View>
        </KeyboardAvoidingView>
      </SafeAreaView>
    </View>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  safe: {
    flex: 1,
  },
  content: {
    flex: 1,
    padding: 24,
    justifyContent: 'center',
    alignItems: 'center',
  },
  titleContainer: {
    alignItems: 'center',
    marginBottom: 40,
  },
  emoji: {
    fontSize: 48,
    marginBottom: 12,
  },
  title: {
    fontSize: 36,
    fontWeight: '900',
    color: '#fff',
    letterSpacing: -1,
  },
  titleAccent: {
    fontSize: 36,
    fontWeight: '900',
    color: '#E1306C',
    letterSpacing: -1,
    marginTop: -6,
  },
  subtitle: {
    fontSize: 14,
    color: '#888',
    marginTop: 8,
    letterSpacing: 1,
    textTransform: 'uppercase',
  },
  card: {
    width: '100%',
    maxWidth: 400,
    backgroundColor: '#16161F',
    borderRadius: 20,
    padding: 24,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  inputLabel: {
    color: '#888',
    fontSize: 11,
    fontWeight: '700',
    letterSpacing: 1.5,
    marginBottom: 8,
  },
  input: {
    height: 52,
    backgroundColor: '#0E0E16',
    borderRadius: 12,
    paddingHorizontal: 16,
    fontSize: 16,
    color: '#fff',
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  codeInput: {
    fontFamily: Platform.OS === 'ios' ? 'Menlo' : 'monospace',
    fontSize: 20,
    letterSpacing: 6,
    textAlign: 'center',
  },
  divider: {
    height: 1,
    backgroundColor: '#2A2A3A',
    marginVertical: 20,
  },
  button: {
    height: 52,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
    marginTop: 16,
  },
  buttonJoin: {
    backgroundColor: '#405DE6',
  },
  buttonCreate: {
    backgroundColor: 'transparent',
    borderWidth: 2,
    borderColor: '#E1306C',
  },
  buttonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  buttonTextCreate: {
    color: '#E1306C',
    fontSize: 16,
    fontWeight: '700',
  },
  orRow: {
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: 20,
  },
  orLine: {
    flex: 1,
    height: 1,
    backgroundColor: '#2A2A3A',
  },
  orText: {
    color: '#666',
    fontSize: 12,
    fontWeight: '700',
    marginHorizontal: 16,
    letterSpacing: 2,
  },
  footerLinks: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'center',
    marginTop: 24,
  },
  footerLinkText: {
    color: '#666677',
    fontSize: 12,
    fontWeight: '500',
    textDecorationLine: 'underline',
  },
  footerLinkDivider: {
    color: '#444455',
    marginHorizontal: 8,
    fontSize: 12,
  },
});
