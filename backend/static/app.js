// WhoSharedThisVideo? — Pure JS Web Client

// -----------------------------------------------------------------------------
// State Configuration
// -----------------------------------------------------------------------------
const state = {
  token: null,
  roomId: null,
  playerId: null,
  roomData: null,
  isHost: false,
  pollInterval: null,
  ws: null,
  wsConnected: false,
  selectedRounds: 20,
  answered: false,
  timerInterval: null,
  timerMsLeft: 0,
  totalTimerMs: 15000, // standard round duration
  currentRoundNo: null,
  myChosenId: null,
  userSelectedRoundsManually: false,
};

// -----------------------------------------------------------------------------
// Initialization
// -----------------------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initApp();
  setupEventListeners();
});

// -----------------------------------------------------------------------------
// App Setup
// -----------------------------------------------------------------------------
async function initApp() {
  // Try loading session from sessionStorage (isolated per tab)
  state.token = sessionStorage.getItem('ws_session_token');
  state.roomId = sessionStorage.getItem('ws_room_id');
  state.playerId = sessionStorage.getItem('ws_player_id');

  if (state.token && state.roomId && state.playerId) {
    showToast('Resuming existing session...', 'info');
    enterLobby();
  } else {
    // If room code in query params, auto-fill join code
    const params = new URLSearchParams(window.location.search);
    const code = params.get('code');
    if (code) {
      document.getElementById('room-code-input').value = code.trim().replace(/[^0-9]/g, '');
      showToast(`Ready to join room ${code}!`, 'info');
    }
    showView('welcome-view');
  }
}

// -----------------------------------------------------------------------------
// Event Listeners
// -----------------------------------------------------------------------------
function setupEventListeners() {
  // Welcome View
  document.getElementById('create-room-btn').addEventListener('click', handleCreateRoom);
  document.getElementById('join-room-btn').addEventListener('click', handleJoinRoom);
  
  // Sanitize room-code-input to digits only
  document.getElementById('room-code-input').addEventListener('input', (e) => {
    e.target.value = e.target.value.replace(/[^0-9]/g, '');
  });

  // Lobby View
  document.getElementById('room-code-display').addEventListener('click', copyRoomCode);
  document.getElementById('leave-lobby-btn').addEventListener('click', handleLeaveRoom);
  document.getElementById('add-reel-btn').addEventListener('click', handleAddReelManual);
  document.getElementById('open-vault-btn').addEventListener('click', openVaultModal);
  document.getElementById('send-chat-btn').addEventListener('click', handleSendChat);
  document.getElementById('chat-input').addEventListener('keypress', (e) => {
    if (e.key === 'Enter') handleSendChat();
  });
  document.getElementById('chat-input').addEventListener('input', updateChatCounter);

  // Host Control Selectors
  document.querySelectorAll('.btn-round').forEach(btn => {
    btn.addEventListener('click', (e) => {
      const rounds = parseInt(e.target.dataset.rounds, 10);
      setRoundCount(rounds);
    });
  });
  document.getElementById('start-game-btn').addEventListener('click', handleStartGame);

  // Game View
  // (Guess buttons are dynamically generated)

  // Leaderboard View
  document.getElementById('leaderboard-leave-btn').addEventListener('click', handleLeaveRoom);
  document.getElementById('leaderboard-playagain-btn').addEventListener('click', handlePlayAgainFromLeaderboard);

  // Modal Controls
  document.getElementById('close-vault-modal').addEventListener('click', closeVaultModal);
  document.getElementById('vault-modal').addEventListener('click', (e) => {
    if (e.target.id === 'vault-modal') closeVaultModal();
  });
  document.getElementById('modal-vault-add-btn').addEventListener('click', handleAddReelToVault);

  // Podium Tab Switchers
  document.querySelectorAll('.podium-tab-btn').forEach(btn => {
    btn.addEventListener('click', (e) => {
      document.querySelectorAll('.podium-tab-btn').forEach(b => b.classList.remove('active'));
      e.target.classList.add('active');
      activePodiumTab = e.target.dataset.tab;
      renderLeaderboard(currentLeaderboardData);
    });
  });
}

// -----------------------------------------------------------------------------
// Session Management
// -----------------------------------------------------------------------------
function saveSession(token, roomId, playerId) {
  state.token = token;
  state.roomId = roomId;
  state.playerId = playerId;
  sessionStorage.setItem('ws_session_token', token);
  sessionStorage.setItem('ws_room_id', roomId);
  sessionStorage.setItem('ws_player_id', playerId);
}

function clearSession() {
  state.token = null;
  state.roomId = null;
  state.playerId = null;
  state.roomData = null;
  state.isHost = false;
  sessionStorage.removeItem('ws_session_token');
  sessionStorage.removeItem('ws_room_id');
  sessionStorage.removeItem('ws_player_id');
  
  if (state.pollInterval) {
    clearInterval(state.pollInterval);
    state.pollInterval = null;
  }
  
  disconnectWebSocket();

  // Clear chat window
  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '<div class="empty-chat">No messages yet. Say hello!</div>';
  }
}

// -----------------------------------------------------------------------------
// View Switching
// -----------------------------------------------------------------------------
function showView(viewId) {
  document.querySelectorAll('.view').forEach(view => {
    view.classList.remove('active');
  });
  const activeView = document.getElementById(viewId);
  if (activeView) {
    activeView.classList.add('active');
  }
}

// -----------------------------------------------------------------------------
// API Request Wrappers
// -----------------------------------------------------------------------------
async function apiCall(endpoint, options = {}) {
  const cleanEndpoint = endpoint.startsWith('/') ? endpoint.slice(1) : endpoint;
  const url = cleanEndpoint.startsWith('api/v1') ? `/${cleanEndpoint}` : `/api/v1/${cleanEndpoint}`;
  
  const headers = {
    'Content-Type': 'application/json',
    ...(options.headers || {})
  };
  
  if (state.token) {
    headers['Authorization'] = `Bearer ${state.token}`;
  }
  
  const config = {
    method: 'GET',
    ...options,
    headers
  };
  
  try {
    const res = await fetch(url, config);
    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      throw { response: { data: errData } };
    }
    return await res.json();
  } catch (error) {
    console.error(`API Error on ${url}:`, error);
    throw error;
  }
}

function extractErrorMessage(detail) {
  if (!detail) return '';
  if (typeof detail === 'string') return detail;
  if (Array.isArray(detail)) {
    return detail
      .map((err) => {
        if (err && typeof err === 'object') {
          const field = err.loc ? err.loc.filter(l => l !== 'body').join('.') : '';
          const msg = err.msg || 'Validation error';
          return field ? `${field}: ${msg}` : msg;
        }
        return String(err);
      })
      .join(', ');
  }
  if (typeof detail === 'object') {
    return detail.message || detail.detail || JSON.stringify(detail);
  }
  return String(detail);
}

// -----------------------------------------------------------------------------
// Welcome View Logic
// -----------------------------------------------------------------------------
async function handleCreateRoom() {
  const name = document.getElementById('nickname-input').value.trim();
  if (!name) {
    showToast('Please enter a display name first.', 'warning');
    return;
  }
  
  try {
    const res = await apiCall('/rooms', {
      method: 'POST',
      body: JSON.stringify({
        display_name: name,
        max_players: 8
      })
    });
    
    saveSession(res.session_token, res.room_id, res.player_id);
    showToast('Room created successfully!', 'success');
    enterLobby();
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'Failed to create room.', 'error');
  }
}

async function handleJoinRoom() {
  const name = document.getElementById('nickname-input').value.trim();
  const code = document.getElementById('room-code-input').value.trim().replace(/[^0-9]/g, '');
  
  if (!name) {
    showToast('Please enter a display name first.', 'warning');
    return;
  }
  if (code.length !== 6) {
    showToast('Room codes must be exactly 6 numbers.', 'warning');
    return;
  }
  
  try {
    const res = await apiCall('/rooms/join', {
      method: 'POST',
      body: JSON.stringify({
        room_code: code,
        display_name: name
      })
    });
    
    saveSession(res.session_token, res.room_id, res.player_id);
    showToast('Joined room successfully!', 'success');
    enterLobby();
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'Failed to join room.', 'error');
  }
}

// -----------------------------------------------------------------------------
// Lobby View Logic
// -----------------------------------------------------------------------------
function enterLobby() {
  // Clear chat logs when entering lobby
  const chatMessagesEl = document.getElementById('chat-messages');
  if (chatMessagesEl) {
    chatMessagesEl.innerHTML = '<div class="empty-chat">No messages yet. Say hello!</div>';
  }

  showView('lobby-view');
  fetchRoom();
  connectWebSocket();
  
  // Set up polling interval (every 3 seconds)
  if (state.pollInterval) clearInterval(state.pollInterval);
  state.pollInterval = setInterval(() => {
    fetchRoom();
    
    // Heartbeat ping
    apiCall(`/rooms/${state.roomId}/heartbeat`, { method: 'POST' }).catch(() => {});
    
    // Auto-reconnect WebSocket if dropped
    if (!state.wsConnected) {
      console.log('[WS] Connection idle or disconnected, auto-reconnecting...');
      connectWebSocket();
    }
  }, 3000);
}

async function fetchRoom() {
  if (!state.roomId) return;
  try {
    const res = await apiCall(`/rooms/${state.roomId}`);
    state.roomData = res;
    
    // Update lobby state
    document.getElementById('room-code-display').textContent = res.code;
    
    // Detect active host status
    const me = res.players.find(p => p.id === state.playerId);
    state.isHost = me ? me.is_host : false;
    
    // Redirect if already playing
    if (res.status === 'playing') {
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      showView('game-view');
      enterGame();
      return;
    }
    
    renderLobbyPlayers(res.players, me);
    renderPoolStatus(res.players, res.vault_counts || {});

    // Calculate standard rounds count dynamically:
    const totalReels = Object.values(res.vault_counts || {}).reduce((a, b) => a + b, 0);
    const activePlayers = res.players.filter(p => p.is_connected);
    const playerCount = activePlayers.length;
    const defaultRounds = playerCount > 0 ? Math.floor(totalReels / playerCount) + (playerCount * 2) : 20;

    if (!state.userSelectedRoundsManually) {
      state.selectedRounds = defaultRounds;
    }

    // Highlight selected round button
    document.querySelectorAll('.btn-round').forEach(btn => {
      if (parseInt(btn.dataset.rounds, 10) === state.selectedRounds) {
        btn.classList.add('active');
      } else {
        btn.classList.remove('active');
      }
    });

    updateHostControls(me);
    
  } catch (err) {
    console.error('Failed to fetch room state:', err);
  }
}

function renderLobbyPlayers(players, me) {
  const container = document.getElementById('player-list');
  const countEl = document.getElementById('player-count');
  
  const activePlayers = players.filter(p => p.is_connected);
  countEl.textContent = `${activePlayers.length}/${state.roomData.max_players}`;
  
  container.innerHTML = activePlayers.map(player => `
    <div class="player-row">
      <div class="player-avatar">${player.display_name.charAt(0).toUpperCase()}</div>
      <div class="player-name">${escapeHtml(player.display_name)}</div>
      ${player.is_host ? '<span class="badge badge-host">HOST</span>' : ''}
      ${player.id === state.playerId ? '<span class="badge badge-you">YOU</span>' : ''}
    </div>
  `).join('');
}

function renderPoolStatus(players, vaultCounts) {
  const minRequired = Math.ceil(state.selectedRounds / 2);
  document.getElementById('requirement-count').textContent = `${minRequired} reels per player`;
  
  const activePlayers = players.filter(p => p.is_connected);
  const totalReels = Object.values(vaultCounts).reduce((a, b) => a + b, 0);
  document.getElementById('pool-total').textContent = totalReels;
  
  const container = document.getElementById('pool-player-list');
  container.innerHTML = activePlayers.map(p => {
    const count = vaultCounts[p.id] || 0;
    const met = count >= minRequired;
    const badgeClass = met ? 'pool-badge-met' : 'pool-badge-under';
    
    return `
      <div class="pool-player-row">
        <div class="pool-player-name">${escapeHtml(p.display_name)}</div>
        <div class="pool-badge ${badgeClass}">${count} / ${minRequired}</div>
      </div>
    `;
  }).join('');
}

function updateHostControls(me) {
  const hostCard = document.getElementById('host-settings-card');
  const waitingCard = document.getElementById('player-waiting-card');
  
  if (state.isHost) {
    hostCard.classList.remove('hidden');
    waitingCard.classList.add('hidden');
    
    // Check if start requirements met
    const minRequired = Math.ceil(state.selectedRounds / 2);
    const activePlayers = state.roomData.players.filter(p => p.is_connected);
    const allMet = activePlayers.every(p => (state.roomData.vault_counts?.[p.id] ?? 0) >= minRequired);
    
    const startBtn = document.getElementById('start-game-btn');
    if (allMet) {
      startBtn.disabled = false;
      startBtn.textContent = 'Start Game';
      document.getElementById('start-error-msg').classList.add('hidden');
    } else {
      startBtn.disabled = true;
      startBtn.textContent = `Need ${minRequired} reels per player`;
    }
  } else {
    hostCard.classList.add('hidden');
    waitingCard.classList.remove('hidden');
    
    const rounds = state.roomData.round_count;
    document.getElementById('waiting-game-info').textContent = `Waiting for host to start the game. Selected rounds: ${rounds} (requires ${Math.ceil(rounds / 2)} reels per player).`;
  }
}

function setRoundCount(rounds) {
  state.selectedRounds = rounds;
  state.userSelectedRoundsManually = true;
  document.querySelectorAll('.btn-round').forEach(btn => {
    if (parseInt(btn.dataset.rounds, 10) === rounds) {
      btn.classList.add('active');
    } else {
      btn.classList.remove('active');
    }
  });
  
  // Re-fetch room to refresh host validation buttons
  fetchRoom();
}

async function handleStartGame() {
  document.getElementById('start-error-msg').classList.add('hidden');
  try {
    await apiCall(`/rooms/${state.roomId}/start`, {
      method: 'POST',
      body: JSON.stringify({
        round_count: state.selectedRounds
      })
    });
    // WebSocket listener will redirect us
  } catch (err) {
    const detail = err.response?.data?.detail;
    const msg = extractErrorMessage(detail) || 'Failed to start game.';
    const errEl = document.getElementById('start-error-msg');
    errEl.textContent = msg;
    errEl.classList.remove('hidden');
    showToast(msg, 'error');
  }
}

async function handleLeaveRoom() {
  if (!confirm('Are you sure you want to leave the room?')) return;
  try {
    await apiCall(`/rooms/${state.roomId}/leave`, { method: 'DELETE' });
  } catch (err) {
    // Ignore errors on leave
  } finally {
    clearSession();
    showToast('Left the room.', 'info');
    showView('welcome-view');
  }
}

function copyRoomCode() {
  const code = document.getElementById('room-code-display').textContent;
  if (!code || code === '------') return;
  navigator.clipboard.writeText(code).then(() => {
    showToast(`Room code ${code} copied to clipboard!`, 'success');
  }).catch(() => {
    showToast('Failed to copy room code.', 'error');
  });
}

// -----------------------------------------------------------------------------
// Reel Ingestion Logic (Lobby)
// -----------------------------------------------------------------------------
async function handleAddReelManual() {
  const input = document.getElementById('reel-url-input');
  const url = input.value.trim();
  if (!url) {
    showToast('Enter or paste a video URL first.', 'warning');
    return;
  }
  
  // Batch URL splitting: support newlines, commas, semicolons
  const urls = url.split(/[\n,\s;]+/).map(u => u.trim()).filter(Boolean);
  if (urls.length === 0) {
    showToast('Enter or paste a video URL first.', 'warning');
    return;
  }
  
  let successCount = 0;
  let dupCount = 0;
  let failCount = 0;
  
  for (const singleUrl of urls) {
    try {
      const res = await apiCall(`/rooms/${state.roomId}/reels`, {
        method: 'POST',
        body: JSON.stringify({ source_url: singleUrl })
      });
      
      if (res?.status === 'already_added') {
        dupCount++;
      } else {
        successCount++;
        // Add to local storage vault clipboard for persistence!
        saveToLocalVault(singleUrl);
      }
    } catch (err) {
      failCount++;
    }
  }
  
  input.value = '';
  fetchRoom();
  
  if (successCount > 0) showToast(`Successfully added ${successCount} video(s)!`, 'success');
  if (dupCount > 0) showToast(`${dupCount} video(s) were already in the pool.`, 'info');
  if (failCount > 0) showToast(`Failed to add ${failCount} video(s).`, 'error');
}

// -----------------------------------------------------------------------------
// Local Storage Vault Integration
// -----------------------------------------------------------------------------
const VAULT_STORAGE_KEY = '@reel_game_clipboard_urls';

function getLocalVault() {
  try {
    const raw = localStorage.getItem(VAULT_STORAGE_KEY);
    return raw ? JSON.parse(raw) : [];
  } catch {
    return [];
  }
}

function saveToLocalVault(url, note = '') {
  try {
    const current = getLocalVault();
    const normalized = url.trim();
    if (current.some(item => item.url.toLowerCase() === normalized.toLowerCase())) {
      return; // Already exists
    }
    const updated = [{ url: normalized, addedAt: Date.now(), note: note }, ...current];
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to write local vault:', e);
  }
}

function removeFromLocalVault(url) {
  try {
    const current = getLocalVault();
    const normalized = url.trim().toLowerCase();
    const updated = current.filter(item => item.url.trim().toLowerCase() !== normalized);
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
  } catch (e) {
    console.error('Failed to remove from local vault:', e);
  }
}

// -----------------------------------------------------------------------------
// Vault Modal view
// -----------------------------------------------------------------------------
function openVaultModal() {
  const modal = document.getElementById('vault-modal');
  modal.classList.remove('hidden');
  renderVaultModalList();
}

function closeVaultModal() {
  document.getElementById('vault-modal').classList.add('hidden');
}

function renderVaultModalList() {
  const vaultItems = getLocalVault();
  const listEl = document.getElementById('vault-modal-list');
  
  if (vaultItems.length === 0) {
    listEl.innerHTML = `<div class="modal-empty">Reelsleriniz boş. URL ekleyerek buraya video biriktirebilirsiniz.</div>`;
    return;
  }
  
  listEl.innerHTML = vaultItems.map(item => {
    const isTiktok = item.url.toLowerCase().includes('tiktok.com');
    const label = isTiktok ? 'TikTok' : item.url.toLowerCase().includes('instagram.com') ? 'Insta' : 'Link';
    const tagClass = isTiktok ? 'tiktok' : 'insta';
    const displayUrl = reelShortcode(item.url);
    const note = item.note || '';
    
    return `
      <div class="vault-item" style="flex-direction: column; align-items: stretch; gap: 8px;">
        <div style="display: flex; align-items: center; justify-content: space-between;">
          <span class="vault-item-tag ${tagClass}">${label}</span>
          <span class="vault-item-url" title="${escapeHtml(item.url)}" style="font-weight: bold; max-width: 180px;">${escapeHtml(displayUrl)}</span>
          <div class="vault-actions">
            <button class="btn btn-primary btn-sm" onclick="addFromVaultToRoom('${escapeJsString(item.url)}')">Ekle</button>
            <button class="btn btn-danger btn-sm" onclick="deleteFromVault('${escapeJsString(item.url)}')">✕</button>
          </div>
        </div>
        <div>
          <input type="text" class="vault-item-note-input" placeholder="Not ekle (Add a note)..." value="${escapeHtml(note)}" onchange="updateVaultItemNote('${escapeJsString(item.url)}', this.value)">
        </div>
      </div>
    `;
  }).join('');
}

async function addFromVaultToRoom(url) {
  try {
    const res = await apiCall(`/rooms/${state.roomId}/reels`, {
      method: 'POST',
      body: JSON.stringify({ source_url: url })
    });
    
    if (res?.status === 'already_added') {
      showToast('This video is already in the room vault!', 'info');
    } else {
      showToast('Video added to room vault!', 'success');
      // Keep in vault so it stays there
    }
  } catch (err) {
    showToast(extractErrorMessage(err.response?.data?.detail) || 'Failed to add video.', 'error');
  } finally {
    renderVaultModalList();
    fetchRoom();
  }
}

function deleteFromVault(url) {
  removeFromLocalVault(url);
  showToast('Removed from vault inbox.', 'info');
  renderVaultModalList();
}

function reelShortcode(url) {
  try {
    if (url.toLowerCase().includes('instagram.com')) {
      const match = url.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
      return match ? `IG: ${match[2].slice(0, 11)}` : `IG: ${url.slice(-15)}`;
    }
    if (url.toLowerCase().includes('tiktok.com')) {
      const match = url.match(/video\/(\d+)/);
      if (match) return `TT: ${match[1].slice(0, 11)}`;
      const parsed = new URL(url);
      return `TT: ${parsed.pathname.slice(0, 15)}`;
    }
    return url.slice(0, 30);
  } catch {
    return url.slice(0, 30);
  }
}

// -----------------------------------------------------------------------------
// WebSocket Management
// -----------------------------------------------------------------------------
function connectWebSocket() {
  if (state.ws) {
    state.ws.onopen = null;
    state.ws.onmessage = null;
    state.ws.onerror = null;
    state.ws.onclose = null;
    state.ws.close();
  }
  
  if (!state.roomId || !state.token) return;
  
  const protocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
  const wsUrl = `${protocol}//${window.location.host}/api/v1/rooms/${state.roomId}/ws?token=${encodeURIComponent(state.token)}`;
  
  console.log('[WS] Connecting to:', wsUrl);
  const socket = new WebSocket(wsUrl);
  
  socket.onopen = () => {
    console.log('[WS] Connected successfully.');
    state.wsConnected = true;
  };
  
  socket.onmessage = (event) => {
    try {
      const msg = JSON.parse(event.data);
      handleWsEvent(msg.event, msg);
    } catch (e) {
      console.warn('[WS] Failed to parse message:', event.data);
    }
  };
  
  socket.onerror = (err) => {
    console.error('[WS] Socket error:', err);
    state.wsConnected = false;
  };
  
  socket.onclose = () => {
    console.log('[WS] Connection closed.');
    state.wsConnected = false;
  };
  
  state.ws = socket;
}

function disconnectWebSocket() {
  if (state.ws) {
    state.ws.close();
    state.ws = null;
  }
  state.wsConnected = false;
}

function handleWsEvent(event, data) {
  console.log(`[WS Event] ${event}:`, data);
  
  switch (event) {
    case 'round_start':
      if (state.pollInterval) {
        clearInterval(state.pollInterval);
        state.pollInterval = null;
      }
      showView('game-view');
      renderRound(data);
      break;
      
    case 'round_result':
      renderRoundResult(data);
      break;
      
    case 'game_end':
      showView('leaderboard-view');
      fetchLeaderboardReport();
      break;
      
    case 'room_reset':
      showView('lobby-view');
      fetchRoom();
      connectWebSocket();
      break;
      
    case 'chat':
      appendChatMessage(data);
      break;
      
    case 'pool_updated':
      fetchRoom();
      break;
  }
}

// -----------------------------------------------------------------------------
// Chat Logic
// -----------------------------------------------------------------------------
function handleSendChat() {
  const input = document.getElementById('chat-input');
  const text = input.value.trim();
  if (!text) return;
  
  if (text.length > 50) {
    showToast('Messages must be 50 characters or less.', 'warning');
    return;
  }
  
  if (!state.wsConnected) {
    showToast('Chat currently offline. Reconnecting...', 'error');
    return;
  }
  
  try {
    state.ws.send(JSON.stringify({
      type: 'chat',
      text: text
    }));
    input.value = '';
    updateChatCounter();
  } catch (err) {
    showToast('Failed to send message.', 'error');
  }
}

function appendChatMessage(data) {
  const container = document.getElementById('chat-messages');
  
  // Remove empty message card if present
  const empty = container.querySelector('.empty-chat');
  if (empty) empty.remove();
  
  const msgEl = document.createElement('div');
  msgEl.className = 'chat-message-item';
  msgEl.innerHTML = `
    <span class="chat-msg-sender">${escapeHtml(data.display_name)}:</span>
    <span class="chat-msg-text">${escapeHtml(data.text)}</span>
  `;
  
  container.appendChild(msgEl);
  
  // Scroll to bottom
  container.scrollTop = container.scrollHeight;
}

function updateChatCounter() {
  const text = document.getElementById('chat-input').value;
  document.getElementById('chat-char-count').textContent = text.length;
}

// -----------------------------------------------------------------------------
// Live Game view Logic
// -----------------------------------------------------------------------------
function enterGame() {
  // Clear any existing game states
  state.answered = false;
  document.getElementById('guess-status-box').classList.add('hidden');
}

function getEmbedUrl(sourceUrl) {
  if (!sourceUrl) return null;
  const urlLower = sourceUrl.toLowerCase();
  
  // Instagram
  if (urlLower.includes('instagram.com')) {
    const match = sourceUrl.match(/\/(reel|reels|p)\/([A-Za-z0-9_-]+)/);
    if (!match) return null;
    return `https://www.instagram.com/reel/${match[2]}/embed/`;
  }
  
  // TikTok
  if (urlLower.includes('tiktok.com')) {
    const match = sourceUrl.match(/video\/(\d+)/);
    if (match) {
      return `https://www.tiktok.com/embed/v2/${match[1]}`;
    }
  }

  // YouTube Shorts
  if (urlLower.includes('youtube.com/shorts/') || urlLower.includes('youtu.be/')) {
    let videoId = null;
    if (urlLower.includes('youtube.com/shorts/')) {
      const match = sourceUrl.match(/shorts\/([A-Za-z0-9_-]+)/);
      if (match) videoId = match[1];
    } else {
      const match = sourceUrl.match(/youtu\.be\/([A-Za-z0-9_-]+)/);
      if (match) videoId = match[1];
    }
    if (videoId) {
      return `https://www.youtube.com/embed/${videoId}`;
    }
  }
  return null;
}

function renderRound(data) {
  state.answered = false;
  state.myChosenId = null;
  state.currentRoundNo = data.round_no;
  
  // Reconstruct game sidebar layout to wipe out the result standings leaderboard
  const sidebar = document.querySelector('.game-sidebar');
  if (sidebar) {
    sidebar.innerHTML = `
      <h3>Who shared this video?</h3>
      <div id="guess-buttons" class="guess-buttons-grid"></div>
      <div id="guess-status-box" class="guess-status-box hidden"></div>
    `;
  }
  
  // Progress Bar reset
  const endsAt = data.round_ends_at ? new Date(data.round_ends_at).getTime() : null;
  const now = Date.now();
  state.totalTimerMs = data.round_duration_ms || 10000;
  
  if (endsAt && endsAt > now) {
    state.timerMsLeft = Math.max(0, endsAt - now);
  } else {
    state.timerMsLeft = state.totalTimerMs;
  }
  updateTimerProgress();
  
  // Set headers
  const total = state.roomData?.round_count ?? 10;
  document.getElementById('game-round-title').textContent = `Round ${data.round_no} / ${total}`;
  
  // Embed video player
  const frame = document.getElementById('reel-embed-frame');
  const fallback = document.getElementById('no-embed-fallback');
  const embedUrl = getEmbedUrl(data.reel_url);
  
  const isTiktok = data.reel_url?.toLowerCase().includes('tiktok.com');
  document.getElementById('media-type-badge').textContent = isTiktok ? 'TIKTOK' : 'INSTAGRAM';
  document.getElementById('media-short-text').textContent = `Video ID: ${data.reel_id.slice(0, 8)}...`;
  
  if (embedUrl) {
    frame.src = embedUrl;
    frame.classList.remove('hidden');
    fallback.classList.add('hidden');
  } else {
    frame.classList.add('hidden');
    fallback.classList.remove('hidden');
    const link = document.getElementById('fallback-link');
    link.href = data.reel_url;
  }
  
  // Reset guess buttons list
  renderGuessButtons(data.options, data.round_no);
  
  // Start countdown timer
  if (state.timerInterval) clearInterval(state.timerInterval);
  const startTick = Date.now();
  const initialMsLeft = state.timerMsLeft;
  state.timerInterval = setInterval(() => {
    const elapsed = Date.now() - startTick;
    state.timerMsLeft = Math.max(0, initialMsLeft - elapsed);
    
    document.getElementById('game-timer').textContent = `${Math.ceil(state.timerMsLeft / 1000)}s`;
    updateTimerProgress();
    
    if (state.timerMsLeft <= 0) {
      clearInterval(state.timerInterval);
    }
  }, 100);
}

function updateTimerProgress() {
  const percent = (state.timerMsLeft / state.totalTimerMs) * 100;
  document.getElementById('game-progress-bar').style.width = `${percent}%`;
}

function renderGuessButtons(options, roundNo) {
  const container = document.getElementById('guess-buttons');
  document.getElementById('guess-status-box').classList.add('hidden');
  
  if (!options) {
    container.innerHTML = '';
    return;
  }
  
  container.innerHTML = options.map((player, idx) => {
    const letter = String.fromCharCode(65 + idx); // A, B, C, ...
    return `
      <button class="guess-btn" data-player-id="${player.id}" onclick="submitGuess('${player.id}')">
        <span class="guess-btn-letter">${letter}</span>
        ${escapeHtml(player.name)}
      </button>
    `;
  }).join('');
}

async function submitGuess(playerId) {
  if (state.answered) return;
  state.answered = true;
  state.myChosenId = playerId;
  
  // Disable all buttons and show active selection
  document.querySelectorAll('.guess-btn').forEach(btn => {
    btn.disabled = true;
    if (btn.dataset.playerId === playerId) {
      btn.classList.add('guess-selected');
    }
  });
  
  const reactionTime = state.totalTimerMs - state.timerMsLeft;
  
  try {
    const res = await apiCall(`/rooms/${state.roomId}/rounds/${state.currentRoundNo}/answer`, {
      method: 'POST',
      body: JSON.stringify({
        chosen_player_id: playerId,
        elapsed_ms: Math.round(reactionTime)
      })
    });
    
    // Result confirmation display - hide correctness feedback until round break
    const statusBox = document.getElementById('guess-status-box');
    statusBox.className = 'guess-status-box correct';
    statusBox.innerHTML = `
      <div class="guess-status-title">Guess Submitted!</div>
      <div class="guess-status-desc">Waiting for the round to end...</div>
    `;
    statusBox.classList.remove('hidden');
  } catch (err) {
    showToast('Failed to submit answer.', 'error');
    state.answered = false;
    state.myChosenId = null;
    document.querySelectorAll('.guess-btn').forEach(btn => btn.disabled = false);
  }
}

function renderRoundResult(data) {
  if (state.timerInterval) {
    clearInterval(state.timerInterval);
    state.timerInterval = null;
  }
  
  const sidebar = document.querySelector('.game-sidebar');
  if (!sidebar) return;

  const owner = data.leaderboard ? data.leaderboard.find(p => p.player_id === data.owner_id) : null;
  const ownerName = owner ? owner.name : 'Unknown';
  
  // Calculate local user's feedback dynamically at the last second
  const isCorrect = state.myChosenId === data.owner_id;
  const scoreGain = data.scores ? (data.scores[state.playerId] || 0) : 0;
  
  const feedbackHtml = `
    <div class="round-feedback-banner ${isCorrect ? 'correct' : 'incorrect'}" style="margin-bottom: 16px; padding: 12px; border-radius: 12px; text-align: center; border: 1px solid var(--border-color); background: ${isCorrect ? 'rgba(16, 185, 129, 0.15)' : 'rgba(239, 68, 68, 0.15)'};">
      <div style="font-size: 16px; font-weight: 800; color: ${isCorrect ? 'var(--success-color)' : 'var(--danger-color)'};">
        ${isCorrect ? 'Correct! 🎉' : 'Incorrect ❌'}
      </div>
      <div style="font-size: 12px; color: var(--text-muted); margin-top: 4px;">
        You earned <strong>+${scoreGain}</strong> points
      </div>
    </div>
  `;
  
  const leaderboardHtml = (data.leaderboard || []).map((player, idx) => {
    let rankEmoji = '';
    if (idx === 0) rankEmoji = '👑 ';
    else if (idx === 1) rankEmoji = '🥈 ';
    else if (idx === 2) rankEmoji = '🥉 ';
    
    const guessScore = data.scores ? (data.scores[player.player_id] || 0) : 0;
    const scoreStr = guessScore > 0 ? `+${guessScore}` : '0';
    const scoreClass = guessScore > 0 ? 'score-gain-positive' : 'score-gain-zero';
    
    return `
      <div class="leaderboard-item-break">
        <div class="leaderboard-rank-break">${rankEmoji || (idx + 1)}</div>
        <div class="leaderboard-name-break">${escapeHtml(player.name)}</div>
        <div class="leaderboard-score-break">
          ${player.score} pts <span class="${scoreClass}">(${scoreStr})</span>
        </div>
      </div>
    `;
  }).join('');
  
  sidebar.innerHTML = `
    <h3 style="margin-bottom: 8px;">Round Results</h3>
    <div class="round-owner-announcement" style="margin-bottom: 12px; font-size: 15px; color: var(--text-secondary);">
      Shared by: <strong style="color: var(--primary-accent);">${escapeHtml(ownerName)}</strong>
    </div>
    
    ${feedbackHtml}
    
    <div class="leaderboard-break-list">
      ${leaderboardHtml}
    </div>
    <div style="margin-top: 24px; font-size: 12px; color: var(--text-muted); text-align: center; font-style: italic;">
      Next round starting in a few seconds...
    </div>
  `;
}

// -----------------------------------------------------------------------------
// Leaderboard View Logic
// -----------------------------------------------------------------------------
let currentLeaderboardData = [];
let activePodiumTab = 'score';

async function fetchLeaderboardReport() {
  try {
    const res = await apiCall(`/rooms/${state.roomId}/report`);
    currentLeaderboardData = res.leaderboard || [];
    renderLeaderboard(currentLeaderboardData);
  } catch (err) {
    showToast('Failed to load final report.', 'error');
  }
}

async function handlePlayAgainFromLeaderboard() {
  try {
    await apiCall(`/rooms/${state.roomId}/play-again`, { method: 'POST' });
    showView('lobby-view');
    fetchRoom();
    connectWebSocket();
    showToast('Room reset for a new match!', 'success');
  } catch (err) {
    const detail = err.response?.data?.detail;
    showToast(extractErrorMessage(detail) || 'Failed to restart game.', 'error');
  }
}

async function handleAddReelToVault() {
  const urlInput = document.getElementById('modal-vault-url-input');
  const noteInput = document.getElementById('modal-vault-note-input');
  const url = urlInput.value.trim();
  const note = noteInput.value.trim();
  
  if (!url) {
    showToast('Enter a video URL first.', 'warning');
    return;
  }
  
  saveToLocalVault(url, note);
  urlInput.value = '';
  noteInput.value = '';
  showToast('Reelslerinize eklendi!', 'success');
  renderVaultModalList();
}

function updateVaultItemNote(url, note) {
  try {
    const current = getLocalVault();
    const normalized = url.trim().toLowerCase();
    const updated = current.map(item => {
      if (item.url.trim().toLowerCase() === normalized) {
        return { ...item, note: note.trim() };
      }
      return item;
    });
    localStorage.setItem(VAULT_STORAGE_KEY, JSON.stringify(updated));
    showToast('Not kaydedildi!', 'success');
  } catch (e) {
    console.error('Failed to save note:', e);
  }
}

function renderLeaderboard(leaderboard) {
  let sorted = [];
  if (activePodiumTab === 'score') {
    sorted = [...leaderboard].sort((a, b) => b.total_score - a.total_score);
  } else if (activePodiumTab === 'speed') {
    sorted = [...leaderboard].sort((a, b) => {
      const timeA = a.avg_reaction_ms !== undefined ? a.avg_reaction_ms : 999999;
      const timeB = b.avg_reaction_ms !== undefined ? b.avg_reaction_ms : 999999;
      return timeA - timeB;
    });
  } else if (activePodiumTab === 'accuracy') {
    sorted = [...leaderboard].sort((a, b) => b.correct_count - a.correct_count);
  }
  
  const p1 = sorted[0];
  const p2 = sorted[1];
  const p3 = sorted[2];
  
  updatePodiumColumn(1, p1, activePodiumTab);
  updatePodiumColumn(2, p2, activePodiumTab);
  updatePodiumColumn(3, p3, activePodiumTab);
}

function updatePodiumColumn(placeNum, player, tabType) {
  const col = document.getElementById(`podium-col-${placeNum}`);
  const nameEl = document.getElementById(`podium-name-${placeNum}`);
  const avatarEl = document.getElementById(`podium-avatar-${placeNum}`);
  const valEl = document.getElementById(`podium-val-${placeNum}`);
  
  if (!player) {
    col.style.opacity = '0.3';
    nameEl.textContent = '-';
    avatarEl.textContent = '?';
    valEl.textContent = '-';
    // Remove dancing class if empty
    nameEl.classList.remove('dancing');
    return;
  }
  
  col.style.opacity = '1';
  nameEl.textContent = player.display_name || player.name || 'Anonymous';
  nameEl.classList.add('dancing'); // Make name dance
  avatarEl.textContent = (player.display_name || player.name || '?').charAt(0).toUpperCase();
  
  let valStr = '';
  if (tabType === 'score') {
    valStr = `${player.total_score} pts`;
  } else if (tabType === 'speed') {
    valStr = player.avg_reaction_ms !== undefined && player.avg_reaction_ms > 0
      ? `${(player.avg_reaction_ms / 1000).toFixed(2)}s`
      : '--';
  } else if (tabType === 'accuracy') {
    valStr = `${player.correct_count} correct`;
  }
  valEl.textContent = valStr;
}

// -----------------------------------------------------------------------------
// Toast Alerts
// -----------------------------------------------------------------------------
function showToast(message, type = 'info') {
  const container = document.getElementById('toast-container');
  const toast = document.createElement('div');
  toast.className = `toast ${type}`;
  toast.textContent = message;
  
  container.appendChild(toast);
  
  // Slide out and remove toast after 3.5 seconds
  setTimeout(() => {
    toast.style.animation = 'fadeIn 0.3s ease-out reverse forwards';
    setTimeout(() => toast.remove(), 300);
  }, 3500);
}

// -----------------------------------------------------------------------------
// Utilities
// -----------------------------------------------------------------------------
function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

function escapeJsString(str) {
  if (!str) return '';
  return str
    .replace(/\\/g, '\\\\')
    .replace(/'/g, "\\'")
    .replace(/"/g, '\\"');
}
