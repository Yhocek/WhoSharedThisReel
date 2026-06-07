import React, { useEffect, useState } from 'react';
import {
  StyleSheet,
  Text,
  View,
  FlatList,
  TouchableOpacity,
  ActivityIndicator,
} from 'react-native';
import { useLocalSearchParams, useRouter } from 'expo-router';
import { SafeAreaView } from 'react-native-safe-area-context';
import api from '../../../lib/api';
import { clearSession } from '../../../lib/session';
import wsManager from '../../../lib/websocket';

type LeaderboardEntry = {
  player_id: string;
  display_name: string;
  total_score: number;
  correct_count: number;
  avg_reaction_ms: number;
};

type MatchReport = {
  room_id: string;
  leaderboard: LeaderboardEntry[];
  streaks?: Record<string, any>;
  averages?: Record<string, any>;
};

export default function ResultsScreen() {
  const { id: roomId } = useLocalSearchParams<{ id: string }>();
  const router = useRouter();
  const [report, setReport] = useState<MatchReport | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const fetchReport = async () => {
      try {
        const res = await api.get(`/rooms/${roomId}/report`);
        setReport(res.data);
      } catch (err: any) {
        setError(err.response?.data?.detail || 'Failed to load report');
      } finally {
        setLoading(false);
      }
    };

    fetchReport();

    // Disconnect WebSocket if still connected
    wsManager.disconnect();
  }, [roomId]);

  const handlePlayAgain = async () => {
    await clearSession();
    router.replace('/');
  };

  if (loading) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <ActivityIndicator size="large" color="#E1306C" />
          <Text style={styles.loadingText}>Loading results...</Text>
        </View>
      </SafeAreaView>
    );
  }

  if (error || !report) {
    return (
      <SafeAreaView style={styles.container}>
        <View style={styles.center}>
          <Text style={styles.errorText}>{error || 'No report available'}</Text>
          <TouchableOpacity style={styles.homeButton} onPress={handlePlayAgain}>
            <Text style={styles.homeButtonText}>Back to Home</Text>
          </TouchableOpacity>
        </View>
      </SafeAreaView>
    );
  }

  const leaderboard = report.leaderboard || [];

  return (
    <SafeAreaView style={styles.container}>
      {/* Title */}
      <View style={styles.header}>
        <Text style={styles.trophy}>🏆</Text>
        <Text style={styles.title}>Game Over!</Text>
      </View>

      {/* Leaderboard */}
      <View style={styles.section}>
        <Text style={styles.sectionTitle}>LEADERBOARD</Text>
        <FlatList
          data={leaderboard}
          keyExtractor={(item) => item.player_id}
          renderItem={({ item, index }) => {
            const medals = ['🥇', '🥈', '🥉'];
            const medal = index < 3 ? medals[index] : `#${index + 1}`;

            return (
              <View
                style={[
                  styles.leaderRow,
                  index === 0 && styles.leaderRowFirst,
                ]}
              >
                <Text style={styles.rank}>{medal}</Text>
                <View style={styles.playerInfo}>
                  <Text style={styles.playerName}>{item.display_name}</Text>
                  <Text style={styles.playerStats}>
                    {item.correct_count} correct · {Math.round(item.avg_reaction_ms)}ms avg
                  </Text>
                </View>
                <Text
                  style={[
                    styles.score,
                    index === 0 && styles.scoreFirst,
                  ]}
                >
                  {item.total_score.toLocaleString()}
                </Text>
              </View>
            );
          }}
          contentContainerStyle={styles.list}
          scrollEnabled={false}
        />
      </View>

      {/* Actions */}
      <View style={styles.actions}>
        <TouchableOpacity
          style={styles.playAgainButton}
          onPress={handlePlayAgain}
          activeOpacity={0.8}
        >
          <Text style={styles.playAgainText}>Play Again</Text>
        </TouchableOpacity>
      </View>
    </SafeAreaView>
  );
}

const styles = StyleSheet.create({
  container: {
    flex: 1,
    backgroundColor: '#0A0A0F',
  },
  center: {
    flex: 1,
    justifyContent: 'center',
    alignItems: 'center',
    padding: 32,
  },
  loadingText: {
    color: '#888',
    fontSize: 16,
    marginTop: 16,
  },
  errorText: {
    color: '#E1306C',
    fontSize: 16,
    textAlign: 'center',
    marginBottom: 24,
  },
  header: {
    alignItems: 'center',
    paddingVertical: 32,
  },
  trophy: {
    fontSize: 56,
    marginBottom: 8,
  },
  title: {
    color: '#fff',
    fontSize: 32,
    fontWeight: '900',
  },
  section: {
    flex: 1,
    paddingHorizontal: 24,
  },
  sectionTitle: {
    color: '#888',
    fontSize: 12,
    fontWeight: '700',
    letterSpacing: 2,
    marginBottom: 16,
  },
  list: {
    gap: 8,
  },
  leaderRow: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: '#16161F',
    borderRadius: 14,
    padding: 16,
    borderWidth: 1,
    borderColor: '#2A2A3A',
  },
  leaderRowFirst: {
    borderColor: '#E1306C',
    backgroundColor: '#1A0A12',
  },
  rank: {
    fontSize: 24,
    width: 40,
    textAlign: 'center',
  },
  playerInfo: {
    flex: 1,
    marginLeft: 12,
  },
  playerName: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
  playerStats: {
    color: '#888',
    fontSize: 12,
    marginTop: 2,
  },
  score: {
    color: '#405DE6',
    fontSize: 20,
    fontWeight: '800',
  },
  scoreFirst: {
    color: '#E1306C',
  },
  actions: {
    padding: 24,
  },
  playAgainButton: {
    height: 52,
    backgroundColor: '#405DE6',
    borderRadius: 14,
    justifyContent: 'center',
    alignItems: 'center',
  },
  playAgainText: {
    color: '#fff',
    fontSize: 18,
    fontWeight: '800',
  },
  homeButton: {
    backgroundColor: '#405DE6',
    height: 48,
    paddingHorizontal: 32,
    borderRadius: 12,
    justifyContent: 'center',
    alignItems: 'center',
  },
  homeButtonText: {
    color: '#fff',
    fontSize: 16,
    fontWeight: '700',
  },
});
