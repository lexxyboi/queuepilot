// Queuepilot Application State Engine

// BroadcastChannel for multi-tab synchronization
const SYNC_CHANNEL_NAME = 'queuepilot_state_sync';
let syncChannel;
try {
  syncChannel = new BroadcastChannel(SYNC_CHANNEL_NAME);
} catch (e) {
  console.warn('BroadcastChannel not supported in this browser. Multi-window sync disabled.', e);
}

// Core App State
let state = {
  players: [], // Queue of checked-in players: { id, name, skill, checkedInAt }
  lobbies: [], // Queue lobbies: { id, name, players: [p1, p2, p3, p4] }
  courts: [],  // Active courts: { id, name, players: [p1, p2, p3, p4], status, matchStartedAt }
  nextId: 1    // Incremental index for unique IDs
};

// Default initial state structure
const DEFAULT_STATE = {
  players: [],
  lobbies: [
    { id: 'lobby-1', name: 'Lobby 1 (Next Up)', players: [null, null, null, null] },
    { id: 'lobby-2', name: 'Lobby 2', players: [null, null, null, null] }
  ],
  courts: [
    { id: 'court-1', name: 'Court 1', players: [null, null, null, null], status: 'Empty', matchStartedAt: null },
    { id: 'court-2', name: 'Court 2', players: [null, null, null, null], status: 'Empty', matchStartedAt: null },
    { id: 'court-3', name: 'Court 3', players: [null, null, null, null], status: 'Empty', matchStartedAt: null },
    { id: 'court-4', name: 'Court 4', players: [null, null, null, null], status: 'Empty', matchStartedAt: null }
  ],
  nextId: 1
};

// Active View State
let currentView = 'admin'; // 'admin' or 'liveboard'
let isStandalone = false;

// Selection variables for the assign-slot modal
let activeAssignTarget = {
  type: null, // 'court' or 'lobby'
  targetId: null, // courtId or lobbyId
  slotIndex: null // 0 to 3
};

// Global player selection state for click-to-assign
let selectedPlayerId = null;

// Global player selection for party linking
let selectedQueuePlayerIds = new Set();

// Skill level abbreviations mapping
const SKILL_ABBR = {
  'Beginner': 'BEG',
  'Novice': 'NOV',
  'Intermediate': 'INT',
  'Advanced': 'ADV'
};

// Pagination state for Liveboard display
let liveboardState = {
  courtPage: 0,
  queuePage: 0,
  courtsPerPage: 4,
  queuePerPage: 15,
  sideView: 'lobbies'
};

// Automation & Matchmaking State
let automationEnabled = false;
let automationIntervalId = null;
let automationLog = [];
const AUTOMATION_TICK_MS = 1500;
const SKILL_RANK = { 'Beginner': 0, 'Novice': 1, 'Intermediate': 2, 'Advanced': 3 };

// -------------------------------------------------------------
// 1. Initial Load & Setup
// -------------------------------------------------------------
document.addEventListener('DOMContentLoaded', () => {
  initViewState();
  loadStateFromStorage();
  setupEventListeners();
  
  // Start the timer rendering interval (every second)
  setInterval(updateActiveMatchClocks, 1000);
  
  // Start dynamic check-in duration tags (every 10 seconds)
  setInterval(updateCheckedInTimes, 10000);
  
  // Start the auto-paging cycle for courts (every 8 seconds)
  setInterval(runLiveboardCourtPaging, 8000);
  
  // Start the auto-paging cycle for side panel (every 8 seconds)
  setInterval(runLiveboardSidePanelPaging, 8000);
  
  // Restore automation state from localStorage
  restoreAutomationState();
  
  // Render initially
  renderUI();
  
  // Listen for sync messages from other tabs/windows (BroadcastChannel)
  if (syncChannel) {
    syncChannel.onmessage = (event) => {
      if (event.data && event.data.type === 'STATE_UPDATE') {
        loadStateFromStorage();
        renderUI();
      }
    };
  }
  
  // Native storage synchronization fallback (works instantly in same-origin tabs)
  window.addEventListener('storage', (event) => {
    if (event.key === 'queuepilot_state' && !syncChannel) {
      loadStateFromStorage();
      renderUI();
    }
  });
});

// Parse URL params to decide if this window is a standalone Liveboard display
function initViewState() {
  const urlParams = new URLSearchParams(window.location.search);
  if (urlParams.get('standalone') === 'true' || urlParams.get('view') === 'liveboard') {
    isStandalone = true;
    currentView = 'liveboard';
    document.body.classList.add('standalone-liveboard');
    
    // Show header but hide nav-controls containing admin trigger button
    const header = document.getElementById('app-header');
    if (header) header.style.display = 'flex';
    
    const navControls = document.querySelector('.nav-controls');
    if (navControls) navControls.style.display = 'none';
    
    const viewAdmin = document.getElementById('view-admin');
    if (viewAdmin) viewAdmin.style.display = 'none';
    
    const adminBottom = document.getElementById('admin-bottom-row');
    if (adminBottom) adminBottom.style.display = 'none';
    
    const viewLiveboard = document.getElementById('view-liveboard');
    if (viewLiveboard) viewLiveboard.classList.add('active');
  } else {
    // Normal client interface
    currentView = 'admin';
    document.body.classList.remove('standalone-liveboard');
    
    const header = document.getElementById('app-header');
    if (header) header.style.display = 'flex';
    
    const navControls = document.querySelector('.nav-controls');
    if (navControls) navControls.style.display = 'flex';
  }
}

// -------------------------------------------------------------
// 2. Storage & Synced Updates
// -------------------------------------------------------------
function saveStateToStorage() {
  localStorage.setItem('queuepilot_state', JSON.stringify(state));
  if (syncChannel) {
    syncChannel.postMessage({ type: 'STATE_UPDATE' });
  }
}

function loadStateFromStorage() {
  const stored = localStorage.getItem('queuepilot_state');
  if (stored) {
    try {
      state = JSON.parse(stored);
      // Clean up compatibility if structure changes
      if (!state.players) state.players = [];
      if (!state.lobbies) state.lobbies = [];
      if (!state.courts) state.courts = [];
      if (!state.nextId) state.nextId = 1;

      // Enforce 2 lobbies maximum limit
      if (state.lobbies.length !== 2) {
        if (state.lobbies.length > 2) {
          // Push any players in extra lobbies back to queue
          for (let i = 2; i < state.lobbies.length; i++) {
            state.lobbies[i].players.forEach(p => {
              if (p) state.players.push(p);
            });
          }
          state.lobbies = state.lobbies.slice(0, 2);
        } else {
          while (state.lobbies.length < 2) {
            const nextNum = state.lobbies.length + 1;
            state.lobbies.push({
              id: `lobby-fixed-${nextNum}`,
              name: `Lobby ${nextNum}${nextNum === 1 ? ' (Next Up)' : ''}`,
              players: [null, null, null, null]
            });
          }
        }
        saveStateToStorage();
      }
    } catch (e) {
      console.error('Error parsing stored state, resetting to defaults.', e);
      state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    }
  } else {
    state = JSON.parse(JSON.stringify(DEFAULT_STATE));
    saveStateToStorage();
  }
}

// -------------------------------------------------------------
// 3. Queue Logic & Core Mutations
// -------------------------------------------------------------

// Add player to general waiting queue
function checkInPlayer(name, skill) {
  const newPlayer = {
    id: `player-${state.nextId++}-${Date.now()}`,
    name: name.trim(),
    skill: skill,
    checkedInAt: Date.now(),
    gamesPlayedToday: 0
  };
  
  state.players.push(newPlayer);
  
  saveStateToStorage();
  renderUI();
}

// Remove player entirely from system (e.g. leave/delete)
function removePlayer(playerId) {
  const player = findGlobalPlayerById(playerId);
  const groupId = player ? player.linkedGroupId : null;

  // 1. Remove from Checked-in Queue
  state.players = state.players.filter(p => p.id !== playerId);
  
  // 2. Remove from lobbies
  state.lobbies.forEach(lobby => {
    for (let i = 0; i < 4; i++) {
      if (lobby.players[i] && lobby.players[i].id === playerId) {
        lobby.players[i] = null;
      }
    }
  });

  // 3. Remove from courts
  state.courts.forEach(court => {
    for (let i = 0; i < 4; i++) {
      if (court.players[i] && court.players[i].id === playerId) {
        court.players[i] = null;
      }
    }
    // If court becomes empty as a result, clean its state
    const activeCount = court.players.filter(p => p !== null).length;
    if (activeCount === 0) {
      court.status = 'Empty';
      court.matchStartedAt = null;
    }
  });
  
  if (groupId) {
    cleanOrphanedLinks(groupId);
  }
  
  // Clean from checkbox selections
  selectedQueuePlayerIds.delete(playerId);
  
  saveStateToStorage();
  renderUI();
}

// Automatically clean up links when a partner is checked out
function cleanOrphanedLinks(groupId) {
  if (!groupId) return;
  let count = 0;
  state.players.forEach(p => { if (p.linkedGroupId === groupId) count++; });
  state.lobbies.forEach(lobby => {
    lobby.players.forEach(p => { if (p && p.linkedGroupId === groupId) count++; });
  });
  state.courts.forEach(court => {
    court.players.forEach(p => { if (p && p.linkedGroupId === groupId) count++; });
  });
  
  const samplePlayer = state.players.find(p => p.linkedGroupId === groupId) || 
                       state.lobbies.flatMap(l => l.players).find(p => p && p.linkedGroupId === groupId) ||
                       state.courts.flatMap(c => c.players).find(p => p && p.linkedGroupId === groupId);
  if (!samplePlayer) return;
  
  const minRequired = samplePlayer.linkType === 'challenge' ? 4 : 2;
  
  if (count < minRequired) {
    const unlink = (p) => {
      if (p && p.linkedGroupId === groupId) {
        delete p.linkedGroupId;
        delete p.linkType;
      }
    };
    state.players.forEach(unlink);
    state.lobbies.forEach(l => l.players.forEach(unlink));
    state.courts.forEach(c => c.players.forEach(unlink));
  }
}

// Check if a group of 4 constitutes an active Challenge match
function isChallengeGroup(players) {
  if (!players || players.length < 4 || players.some(p => p === null)) return false;
  const firstGroupId = players[0].linkedGroupId;
  if (!firstGroupId) return false;
  return players.every(p => p.linkedGroupId === firstGroupId && p.linkType === 'challenge');
}

// Queue checkbox selection handlers
function handleQueuePlayerCheck(event, playerId) {
  if (selectedQueuePlayerIds.has(playerId)) {
    selectedQueuePlayerIds.delete(playerId);
  } else {
    if (selectedQueuePlayerIds.size >= 4) {
      alert("You can select a maximum of 4 players to link.");
      event.target.checked = false;
      return;
    }
    selectedQueuePlayerIds.add(playerId);
  }
  renderLinkingControls();
}

function renderLinkingControls() {
  const bar = document.getElementById('linking-actions-bar');
  if (!bar) return;
  
  if (selectedQueuePlayerIds.size === 0) {
    bar.style.display = 'none';
    return;
  }
  
  bar.style.display = 'flex';
  
  let anyLinked = false;
  selectedQueuePlayerIds.forEach(id => {
    const p = findGlobalPlayerById(id);
    if (p && p.linkedGroupId) anyLinked = true;
  });
  
  const count = selectedQueuePlayerIds.size;
  const canDuo = (count === 2) && !anyLinked;
  const canChallenge = (count === 4) && !anyLinked;
  
  bar.innerHTML = `
    <span style="font-size: 0.8rem; font-weight: 700; color: var(--text-secondary);">${count} Selected</span>
    <div class="btn-group">
      ${anyLinked ? `
        <button class="court-btn finish-btn" onclick="unlinkSelected()" style="font-size: 0.75rem; padding: 0.3rem 0.6rem; border-color: rgba(239, 68, 68, 0.3); color: #ef4444; background: rgba(239, 68, 68, 0.1);">
          Unlink
        </button>
      ` : ''}
      <button class="court-btn start-btn" onclick="linkAsDuo()" ${canDuo ? '' : 'disabled'} style="font-size: 0.75rem; padding: 0.3rem 0.6rem; ${canDuo ? '' : 'opacity: 0.4; cursor: not-allowed;'}; border-color: rgba(59, 130, 246, 0.3); color: #60a5fa; background: rgba(59, 130, 246, 0.1);">
        Link Duo
      </button>
      <button class="court-btn start-btn" onclick="linkAsChallenge()" ${canChallenge ? '' : 'disabled'} style="font-size: 0.75rem; padding: 0.3rem 0.6rem; ${canChallenge ? '' : 'opacity: 0.4; cursor: not-allowed;'}; border-color: rgba(234, 88, 12, 0.3); color: #f97316; background: rgba(234, 88, 12, 0.1);">
        Link Challenge
      </button>
      <button class="court-btn" onclick="clearQueueSelection()" style="font-size: 0.75rem; padding: 0.3rem 0.6rem;">
        Clear
      </button>
    </div>
  `;
}

function linkAsDuo() {
  if (selectedQueuePlayerIds.size !== 2) return;
  const playerIds = Array.from(selectedQueuePlayerIds);
  const playerA = findGlobalPlayerById(playerIds[0]);
  const playerB = findGlobalPlayerById(playerIds[1]);
  if (!playerA || !playerB) return;
  
  const groupId = `group-duo-${Date.now()}`;
  playerA.linkedGroupId = groupId;
  playerA.linkType = 'duo';
  playerB.linkedGroupId = groupId;
  playerB.linkType = 'duo';
  
  selectedQueuePlayerIds.clear();
  saveStateToStorage();
  renderUI();
}

function linkAsChallenge() {
  if (selectedQueuePlayerIds.size !== 4) return;
  const playerIds = Array.from(selectedQueuePlayerIds);
  const playersToLink = playerIds.map(id => findGlobalPlayerById(id)).filter(p => p !== null);
  if (playersToLink.length !== 4) return;
  
  const groupId = `group-challenge-${Date.now()}`;
  playersToLink.forEach(p => {
    p.linkedGroupId = groupId;
    p.linkType = 'challenge';
  });
  
  selectedQueuePlayerIds.clear();
  saveStateToStorage();
  renderUI();
}

function unlinkSelected() {
  selectedQueuePlayerIds.forEach(id => {
    const player = findGlobalPlayerById(id);
    if (player && player.linkedGroupId) {
      const groupId = player.linkedGroupId;
      const unlink = (p) => {
        if (p && p.linkedGroupId === groupId) {
          delete p.linkedGroupId;
          delete p.linkType;
        }
      };
      state.players.forEach(unlink);
      state.lobbies.forEach(l => l.players.forEach(unlink));
      state.courts.forEach(c => c.players.forEach(unlink));
    }
  });
  
  selectedQueuePlayerIds.clear();
  saveStateToStorage();
  renderUI();
}

function clearQueueSelection() {
  selectedQueuePlayerIds.clear();
  renderUI();
}

// Promotes the players in Lobby 1 to a specific court
function loadCourtFromLobby(courtId) {
  const court = state.courts.find(c => c.id === courtId);
  if (!court) return;
  
  // Get players in Lobby 1 (Next Up)
  if (state.lobbies.length > 0) {
    const nextLobby = state.lobbies[0];
    const incomingPlayers = [...nextLobby.players];
    
    // Copy lobby players to court slots
    for (let i = 0; i < 4; i++) {
      court.players[i] = incomingPlayers[i];
    }
    
    // If we loaded players, set status to Warm-up, set timer
    const count = court.players.filter(p => p !== null).length;
    if (count > 0) {
      court.status = 'Warm-up';
      court.matchStartedAt = Date.now();
    } else {
      court.status = 'Empty';
      court.matchStartedAt = null;
    }
    
    // Slide lobbies forward
    shiftLobbies();
  }
}

// Shifts lobbies forward (Lobby 2 -> Lobby 1)
function shiftLobbies() {
  if (state.lobbies.length === 0) return;
  
  // Shift players forward in each lobby
  for (let i = 0; i < state.lobbies.length - 1; i++) {
    state.lobbies[i].players = [...state.lobbies[i+1].players];
  }
  
  // Set the last lobby to empty slots
  const lastLobby = state.lobbies[state.lobbies.length - 1];
  lastLobby.players = [null, null, null, null];
}

// Start active playing match on court
function startMatch(courtId) {
  const court = state.courts.find(c => c.id === courtId);
  if (!court) return;
  
  // Check if there are any players on the court
  const count = court.players.filter(p => p !== null).length;
  if (count === 0) {
    alert("Cannot start match: No players are assigned to this court.");
    return;
  }
  
  court.status = 'In Progress';
  court.matchStartedAt = Date.now();
  saveStateToStorage();
  renderUI();
}

// Ends the match, clears the court, and leaves it empty (manual promotion)
function finishMatch(courtId) {
  const court = state.courts.find(c => c.id === courtId);
  if (!court) return;
  
  // 1. Return active court players back to Checked-in Queue
  //    Stamp lastPlayedAt so recently-finished players get lower priority
  const playerIds = court.players.filter(p => p !== null).map(p => p.id);
  court.players.forEach(p => {
    if (p) {
      p.lastPlayedAt = Date.now();
      p.gamesPlayedToday = (p.gamesPlayedToday || 0) + 1;
      
      // Update recently played with history
      p.recentlyPlayedWith = p.recentlyPlayedWith || [];
      const others = playerIds.filter(id => id !== p.id);
      p.recentlyPlayedWith = [...others, ...p.recentlyPlayedWith];
      // Keep only last 12 player IDs (approx 4 matches)
      p.recentlyPlayedWith = p.recentlyPlayedWith.slice(0, 12);
      
      state.players.push(p);
    }
  });
  
  // 2. Clear court
  court.players = [null, null, null, null];
  court.status = 'Empty';
  court.matchStartedAt = null;
  
  saveStateToStorage();
  renderUI();
}

// -------------------------------------------------------------
// 4. Scalable Court & Lobby Adjustments
// -------------------------------------------------------------
function addCourt() {
  const newNum = state.courts.length + 1;
  const newCourt = {
    id: `court-${Date.now()}-${newNum}`,
    name: `Court ${newNum}`,
    players: [null, null, null, null],
    status: 'Empty',
    matchStartedAt: null
  };
  state.courts.push(newCourt);
  saveStateToStorage();
  renderUI();
}

function removeCourt(courtId) {
  if (state.courts.length === 0) return;
  
  // Find court to delete
  const targetIndex = courtId ? state.courts.findIndex(c => c.id === courtId) : state.courts.length - 1;
  if (targetIndex === -1) return;
  
  const targetCourt = state.courts[targetIndex];
  
  // Return active players in court back to queue
  targetCourt.players.forEach(p => {
    if (p) state.players.push(p);
  });
  
  state.courts.splice(targetIndex, 1);
  
  // Recalculate names to keep numbering clean
  state.courts.forEach((c, idx) => {
    // Only rename if it is a standard sequential name
    if (c.name.startsWith('Court ')) {
      c.name = `Court ${idx + 1}`;
    }
  });
  
  saveStateToStorage();
  renderUI();
}



// -------------------------------------------------------------
// 5. DOM Event Listeners & Modals
// -------------------------------------------------------------
function setupEventListeners() {
  
  // Open Standalone Liveboard Window
  const btnOpenStandalone = document.getElementById('btn-open-standalone');
  if (btnOpenStandalone) {
    btnOpenStandalone.addEventListener('click', () => {
      const liveboardUrl = window.location.pathname + '?standalone=true';
      window.open(liveboardUrl, '_blank', 'width=1280,height=800,menubar=no,status=no,toolbar=no');
    });
  }

  // Panel Tabs Switching Logic
  const tabBtns = document.querySelectorAll('.tab-btn');
  tabBtns.forEach(btn => {
    btn.addEventListener('click', () => {
      // Remove active class from all buttons and contents in this panel
      const panel = btn.closest('.panel');
      panel.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      panel.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      
      // Add active class to clicked button and target content
      btn.classList.add('active');
      const targetId = 'tab-' + btn.getAttribute('data-tab');
      document.getElementById(targetId).classList.add('active');
      
      // Recalculate marquees since elements are now visible
      applyMarqueeProperties();
    });
  });

  // Player Check-in Submit Form
  const formCheckin = document.getElementById('form-checkin');
  if (formCheckin) {
    formCheckin.addEventListener('submit', (e) => {
      e.preventDefault();
      const input = document.getElementById('player-name-input');
      const name = input.value;
      const skillInput = document.querySelector('input[name="skill-level"]:checked');
      const skill = skillInput ? skillInput.value : 'Beginner';
      
      if (name.trim()) {
        checkInPlayer(name, skill);
        input.value = '';
        input.focus();
      }
    });
  }

  // Scalable Config buttons
  const btnAddCourt = document.getElementById('btn-add-court');
  if (btnAddCourt) btnAddCourt.addEventListener('click', () => addCourt());
  
  const btnRemoveCourt = document.getElementById('btn-remove-court');
  if (btnRemoveCourt) btnRemoveCourt.addEventListener('click', () => removeCourt());
  


  // Edit Player Modal cancel & save
  const modalEdit = document.getElementById('modal-edit-player');
  const btnCloseEditModal = document.getElementById('btn-close-edit-modal');
  const btnCancelEditPlayer = document.getElementById('btn-cancel-edit-player');
  const formEditPlayer = document.getElementById('form-edit-player');
  
  const closeEditModal = () => {
    if (modalEdit) modalEdit.classList.remove('active');
  };
  
  if (btnCloseEditModal) btnCloseEditModal.addEventListener('click', closeEditModal);
  if (btnCancelEditPlayer) btnCancelEditPlayer.addEventListener('click', closeEditModal);
  
  if (formEditPlayer) {
    formEditPlayer.addEventListener('submit', (e) => {
      e.preventDefault();
      const pId = document.getElementById('edit-player-id').value;
      const pName = document.getElementById('edit-player-name').value;
      const pSkillInput = document.querySelector('input[name="edit-skill-level"]:checked');
      const pSkill = pSkillInput ? pSkillInput.value : 'Beginner';
      
      if (pName.trim()) {
        updatePlayerDetails(pId, pName, pSkill);
        closeEditModal();
      }
    });
  }

  // Assign Slot Modal setup
  const modalAssign = document.getElementById('modal-assign-slot');
  const btnCloseAssignModal = document.getElementById('btn-close-assign-modal');
  const btnCancelAssign = document.getElementById('btn-cancel-assign');
  const btnClearSlot = document.getElementById('btn-clear-slot');
  const searchInput = document.getElementById('assign-player-search');
  
  const closeAssignModal = () => {
    if (modalAssign) modalAssign.classList.remove('active');
  };
  
  if (btnCloseAssignModal) btnCloseAssignModal.addEventListener('click', closeAssignModal);
  if (btnCancelAssign) btnCancelAssign.addEventListener('click', closeAssignModal);
  
  if (btnClearSlot) {
    btnClearSlot.addEventListener('click', () => {
      clearSlot(activeAssignTarget.type, activeAssignTarget.targetId, activeAssignTarget.slotIndex);
      closeAssignModal();
    });
  }
  
  if (searchInput) {
    searchInput.addEventListener('input', () => {
      renderAssignPlayersList(searchInput.value);
    });
  }
  
  // Automation Toggle
  const toggleAutomation = document.getElementById('toggle-automation');
  if (toggleAutomation) {
    toggleAutomation.addEventListener('change', () => {
      if (toggleAutomation.checked) {
        startAutomation();
      } else {
        stopAutomation();
      }
    });
  }
}

// Edit player modal values injection
function openEditPlayerModal(playerId) {
  const player = findGlobalPlayerById(playerId);
  if (!player) return;
  
  document.getElementById('edit-player-id').value = player.id;
  document.getElementById('edit-player-name').value = player.name;
  
  const skillRadios = document.getElementsByName('edit-skill-level');
  skillRadios.forEach(radio => {
    radio.checked = (radio.value === player.skill);
  });
  
  const modal = document.getElementById('modal-edit-player');
  if (modal) modal.classList.add('active');
}

// Save modified details back into whatever slot player resides in
function updatePlayerDetails(id, name, skill) {
  // 1. Queue list update
  let player = state.players.find(p => p.id === id);
  if (player) {
    player.name = name.trim();
    player.skill = skill;
  }
  
  // 2. Lobbies update
  state.lobbies.forEach(l => {
    l.players.forEach(p => {
      if (p && p.id === id) {
        p.name = name.trim();
        p.skill = skill;
      }
    });
  });
  
  // 3. Courts update
  state.courts.forEach(c => {
    c.players.forEach(p => {
      if (p && p.id === id) {
        p.name = name.trim();
        p.skill = skill;
      }
    });
  });
  
  saveStateToStorage();
  renderUI();
}

// Find a player object anywhere in state
function findGlobalPlayerById(id) {
  let p = state.players.find(x => x.id === id);
  if (p) return p;
  
  for (let l of state.lobbies) {
    p = l.players.find(x => x && x.id === id);
    if (p) return p;
  }
  
  for (let c of state.courts) {
    p = c.players.find(x => x && x.id === id);
    if (p) return p;
  }
  
  return null;
}

// Open assignment options modal for court or lobby slot
function openAssignModal(type, targetId, slotIndex) {
  activeAssignTarget = { type, targetId, slotIndex };
  
  const modal = document.getElementById('modal-assign-slot');
  const searchInput = document.getElementById('assign-player-search');
  const title = document.getElementById('assign-modal-title');
  
  // Set title description
  let targetName = '';
  if (type === 'court') {
    const court = state.courts.find(c => c.id === targetId);
    targetName = court ? `${court.name} - Slot ${slotIndex + 1}` : 'Court Slot';
  } else {
    const lobby = state.lobbies.find(l => l.id === targetId);
    targetName = lobby ? `${lobby.name} - Slot ${slotIndex + 1}` : 'Lobby Slot';
  }
  title.textContent = `Assign Player to ${targetName}`;
  
  if (searchInput) {
    searchInput.value = '';
  }
  
  renderAssignPlayersList('');
  
  if (modal) modal.classList.add('active');
}

// Dynamic rendering inside assignment search modal
function renderAssignPlayersList(query) {
  const container = document.getElementById('assign-players-list');
  if (!container) return;
  
  container.innerHTML = '';
  const lowerQuery = query.toLowerCase();
  
  // List checked-in players matching query
  const filteredQueue = state.players.filter(p => p.name.toLowerCase().includes(lowerQuery));
  
  if (filteredQueue.length === 0 && query.trim() !== '') {
    // Provide a Quick Guest creation trigger if searched name has no match
    const guestLi = document.createElement('div');
    guestLi.className = 'player-card-compact';
    guestLi.style.cursor = 'pointer';
    guestLi.innerHTML = `
      <div class="player-info-row">
        <span class="player-name" title="Create & Assign Guest: &quot;${escapeHtml(query)}&quot;">
          <span class="player-name-inner">Create & Assign Guest: "${escapeHtml(query)}"</span>
        </span>
        <span class="badge badge-beginner">BEG</span>
      </div>
      <button class="btn-primary" style="font-size: 0.75rem; padding: 0.25rem 0.5rem; flex-shrink: 0; margin-left: 1rem; width: auto; box-shadow: none;">Create</button>
    `;
    guestLi.addEventListener('click', () => {
      const guestPlayer = {
        id: `guest-${state.nextId++}-${Date.now()}`,
        name: query.trim(),
        skill: 'Beginner',
        checkedInAt: Date.now()
      };
      assignPlayerToSlot(guestPlayer);
      document.getElementById('modal-assign-slot').classList.remove('active');
    });
    container.appendChild(guestLi);
  }
  
  // Add matching queue players
  filteredQueue.forEach(player => {
    const playerLi = document.createElement('div');
    playerLi.className = 'player-card-compact';
    playerLi.style.cursor = 'pointer';
    playerLi.innerHTML = `
      <div class="player-info-row">
        <span class="player-name" title="${escapeHtml(player.name)}">
          <span class="player-name-inner">${escapeHtml(player.name)}</span>
        </span>
        <span class="badge badge-${player.skill.toLowerCase()}">${SKILL_ABBR[player.skill] || player.skill}</span>
      </div>
      <button class="court-btn start-btn" style="padding: 0.25rem 0.5rem; font-size: 0.75rem; flex-shrink: 0; margin-left: 1rem;">Assign</button>
    `;
    playerLi.addEventListener('click', () => {
      // Remove player from queue array
      state.players = state.players.filter(p => p.id !== player.id);
      assignPlayerToSlot(player);
      document.getElementById('modal-assign-slot').classList.remove('active');
    });
    container.appendChild(playerLi);
  });
  
  // Recalculate marquee animations for the players rendered in the assign slot search list
  applyMarqueeProperties();
  
  if (filteredQueue.length === 0 && query.trim() === '') {
    container.innerHTML = `<div style="text-align: center; color: var(--text-muted); font-size: 0.8rem; padding: 1rem;">No players in queue. Check in players first.</div>`;
  }
}

// Assigns selected player object into slot target
function assignPlayerToSlot(player) {
  const { type, targetId, slotIndex } = activeAssignTarget;
  
  if (type === 'court') {
    const court = state.courts.find(c => c.id === targetId);
    if (court) {
      // If slot was occupied, move occupant back to queue
      const oldOccupant = court.players[slotIndex];
      if (oldOccupant) {
        state.players.push(oldOccupant);
      }
      court.players[slotIndex] = player;
      
      // Auto transition empty court to Warm-up if loaded
      const count = court.players.filter(p => p !== null).length;
      if (court.status === 'Empty' && count > 0) {
        court.status = 'Warm-up';
        court.matchStartedAt = Date.now();
      }
    }
  } else {
    // lobby slot
    const lobby = state.lobbies.find(l => l.id === targetId);
    if (lobby) {
      const oldOccupant = lobby.players[slotIndex];
      if (oldOccupant) {
        state.players.push(oldOccupant);
      }
      lobby.players[slotIndex] = player;
    }
  }
  
  saveStateToStorage();
  renderUI();
}

// Clears player slot and returns them to general queue
function clearSlot(type, targetId, slotIndex) {
  if (type === 'court') {
    const court = state.courts.find(c => c.id === targetId);
    if (court) {
      const player = court.players[slotIndex];
      if (player) {
        state.players.push(player);
        court.players[slotIndex] = null;
      }
      
      // If court is now entirely empty, reset status
      const count = court.players.filter(p => p !== null).length;
      if (count === 0) {
        court.status = 'Empty';
        court.matchStartedAt = null;
      }
    }
  } else {
    // lobby slot
    const lobby = state.lobbies.find(l => l.id === targetId);
    if (lobby) {
      const player = lobby.players[slotIndex];
      if (player) {
        state.players.push(player);
        lobby.players[slotIndex] = null;
      }
    }
  }
  
  saveStateToStorage();
  renderUI();
}

// Helper to escape HTML characters
function escapeHtml(text) {
  const map = {
    '&': '&amp;',
    '<': '&lt;',
    '>': '&gt;',
    '"': '&quot;',
    "'": '&#039;'
  };
  return String(text).replace(/[&<>"']/g, function(m) { return map[m]; });
}

// -------------------------------------------------------------
// 6. Rendering Mechanics
// -------------------------------------------------------------

function renderUI() {
  const viewAdmin = document.getElementById('view-admin');
  const viewLiveboard = document.getElementById('view-liveboard');

  if (currentView === 'admin') {
    if (viewAdmin) viewAdmin.style.display = 'grid';
    if (viewLiveboard) viewLiveboard.classList.remove('active');
    
    renderAdminQueue();
    renderAdminEditPlayersList();
    renderAdminLobbies();
    renderAdminCourts();
    renderQueueAnalytics();
  } else {
    if (viewAdmin) viewAdmin.style.display = 'none';
    if (viewLiveboard) viewLiveboard.classList.add('active');
    
    recalculateLiveboardCapacities();
    
    renderLiveboardCourts();
    renderLiveboardLobbies();
    renderLiveboardQueue();
  }
  
  // Update automation status label and toggle container
  const autoLabel = document.getElementById('automation-status-label');
  const autoContainer = document.getElementById('automation-toggle-container');
  if (autoLabel) {
    autoLabel.textContent = automationEnabled ? 'Auto: ON' : 'Auto: OFF';
    autoLabel.className = automationEnabled ? 'automation-label active' : 'automation-label';
  }
  if (autoContainer) {
    autoContainer.classList.toggle('active', automationEnabled);
  }
  
  // Toggle auto-managed class on lobbies panel
  const lobbiesPanel = document.getElementById('panel-lobbies');
  if (lobbiesPanel) {
    lobbiesPanel.classList.toggle('auto-managed', automationEnabled);
  }
  
  // Render automation log
  renderAutomationLog();
  
  // Dynamically calculate marquee parameters for long player names
  applyMarqueeProperties();
}

// -- 6.1 ADMIN VIEW RENDERS --

function renderAdminQueue() {
  const container = document.getElementById('queue-list-container');
  const countLabel = document.getElementById('queue-count');
  if (!container) return;
  
  // Clean up selectedQueuePlayerIds to only contain players currently in state.players
  const activePlayerIds = new Set(state.players.map(p => p.id));
  selectedQueuePlayerIds.forEach(id => {
    if (!activePlayerIds.has(id)) {
      selectedQueuePlayerIds.delete(id);
    }
  });
  
  let totalActivePlayers = state.players.length;
  state.lobbies.forEach(l => totalActivePlayers += l.players.filter(p => p !== null).length);
  state.courts.forEach(c => totalActivePlayers += c.players.filter(p => p !== null).length);
  countLabel.textContent = `${totalActivePlayers} Player${totalActivePlayers === 1 ? '' : 's'}`;
  
  if (state.players.length === 0) {
    container.innerHTML = `
      <div class="empty-placeholder">
        <span class="empty-placeholder-icon">🎾</span>
        <p class="empty-placeholder-text">No players checked in yet.</p>
      </div>
    `;
    const bar = document.getElementById('linking-actions-bar');
    if (bar) bar.style.display = 'none';
    return;
  }
  
  container.innerHTML = '';
  state.players.forEach(player => {
    const card = document.createElement('div');
    card.className = `player-card ${selectedPlayerId === player.id ? 'selected-for-assign' : ''}`;
    card.setAttribute('draggable', 'true');
    card.setAttribute('ondragstart', `handleDragStart(event, '${player.id}')`);
    card.setAttribute('onclick', `togglePlayerSelection(event, '${player.id}')`);
    
    // Bottom border for skill
    card.style.borderBottom = `3px solid var(--color-${player.skill.toLowerCase()})`;
    
    // Left border indicator if linked
    if (player.linkedGroupId) {
      if (player.linkType === 'challenge') {
        card.style.borderLeft = '4px solid #ea580c';
      } else {
        card.style.borderLeft = '4px solid #3b82f6';
      }
    }
    
    const isChecked = selectedQueuePlayerIds.has(player.id);
    const linkBadge = player.linkedGroupId ? 
      (player.linkType === 'challenge' ? '<span class="link-badge challenge-badge">🔥 Challenge</span>' : '<span class="link-badge duo-badge">🔗 Duo</span>') : '';
    
    card.innerHTML = `
      <input type="checkbox" class="player-queue-checkbox" onclick="event.stopPropagation(); handleQueuePlayerCheck(event, '${player.id}')" ${isChecked ? 'checked' : ''}>
      <span class="player-name" title="${escapeHtml(player.name)}">
        <span class="player-name-inner">${escapeHtml(player.name)}</span>
      </span>
      ${linkBadge}
    `;
    container.appendChild(card);
  });
  
  renderLinkingControls();
}

function renderAdminLobbies() {
  const container = document.getElementById('lobbies-list-container');
  const countLabel = document.getElementById('lobby-count');
  if (!container) return;
  
  countLabel.textContent = `${state.lobbies.length} Lobbi${state.lobbies.length === 1 ? 'y' : 'es'}`;
  
  if (state.lobbies.length === 0) {
    container.innerHTML = `
      <div class="empty-placeholder">
        <span class="empty-placeholder-icon">🗂️</span>
        <p class="empty-placeholder-text">No lobbies created.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  state.lobbies.forEach((lobby, lIdx) => {
    const isFirst = lIdx === 0;
    const isChallenge = isChallengeGroup(lobby.players);
    
    const card = document.createElement('div');
    card.className = `lobby-card ${isFirst ? 'next-up' : ''} ${isChallenge ? 'challenge-lobby' : ''}`;
    
    let slotsHtml = '';
    for (let s = 0; s < 4; s++) {
      const p = lobby.players[s];
      if (p) {
        const initials = p.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const partner = lobby.players.find(other => other && other.id !== p.id && other.linkedGroupId && other.linkedGroupId === p.linkedGroupId && other.linkType === 'duo');
        const duoIcon = partner ? `<span style="color: #60a5fa; font-size: 0.75rem; margin-right: 0.2rem;" title="Linked Duo with ${escapeHtml(partner.name)}">🔗</span>` : '';
        
        slotsHtml += `
          <div class="lobby-slot occupied" title="Click to edit or clear player" 
               onclick="handleSlotClick(event, 'lobby', '${lobby.id}', ${s})"
               draggable="true"
               ondragstart="handleSlotDragStart(event, '${p.id}', 'lobby', '${lobby.id}', ${s})"
               ondragover="handleDragOver(event)"
               ondragenter="handleDragEnter(event)"
               ondragleave="handleDragLeave(event)"
               ondrop="handleDrop(event, 'lobby', '${lobby.id}', ${s})">
            <span class="slot-initials">${escapeHtml(initials)}</span>
            <span class="slot-name">${duoIcon}${escapeHtml(p.name)}</span>
            <span class="badge badge-${p.skill.toLowerCase()}" style="font-size: 0.55rem; padding: 0.05rem 0.25rem; position: absolute; top: 4px; right: 4px; z-index: 1;">${SKILL_ABBR[p.skill] || p.skill}</span>
            <span class="slot-indicator" style="background-color: var(--color-${p.skill.toLowerCase()});"></span>
          </div>
        `;
      } else {
        slotsHtml += `
          <div class="lobby-slot" title="Click to manually assign player" 
               onclick="handleSlotClick(event, 'lobby', '${lobby.id}', ${s})"
               ondragover="handleDragOver(event)"
               ondragenter="handleDragEnter(event)"
               ondragleave="handleDragLeave(event)"
               ondrop="handleDrop(event, 'lobby', '${lobby.id}', ${s})">
            <span>+</span>
            <span class="slot-name">Open</span>
          </div>
        `;
      }
    }
    
    const autoManagedBadge = automationEnabled ? '<span class="auto-managed-badge">🤖 Auto</span>' : '';
    const challengeBadge = isChallenge ? '<span class="challenge-match-badge">🔥 Challenge</span>' : '';
    
    card.innerHTML = `
      <div class="lobby-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <span class="lobby-title">${escapeHtml(lobby.name)}</span>
          ${challengeBadge}
          ${autoManagedBadge}
        </div>
        <button class="action-btn delete" title="Quick Clear Lobby" onclick="quickClearLobby('${lobby.id}')" style="margin-left: auto; margin-right: ${isFirst ? '4.5rem' : '0'}; width: 1.5rem; height: 1.5rem; border: 1px solid rgba(244, 63, 94, 0.2); border-radius: 4px; display: flex; align-items: center; justify-content: center; color: var(--color-advanced);">
          <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5" viewBox="0 0 24 24"><path d="M19 7l-.867 12.142A2 2 0 0116.138 21H7.862a2 2 0 01-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 00-1-1h-4a1 1 0 00-1 1v3M4 7h16"></path></svg>
        </button>
      </div>
      <div class="lobby-slots">
        ${slotsHtml}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderQueueAnalytics() {
  const container = document.getElementById('queue-analytics-container');
  if (!container) return;

  const ASSUMED_MATCH_MINS = 15;

  const emptyCourtsCount = state.courts.filter(c => c.status === 'Empty').length;
  const activeCourts = state.courts.filter(c => c.status !== 'Empty');
  const totalWaitingCount = state.players.length + state.lobbies.reduce((acc, l) => acc + l.players.filter(p => p !== null).length, 0);

  let estWaitTime = 0;
  if (totalWaitingCount > 0) {
    // Players that can fill empty courts right away
    const immediateSlots = emptyCourtsCount * 4;
    const remainingWaiting = Math.max(0, totalWaitingCount - immediateSlots);

    if (remainingWaiting === 0) {
      // Everyone fits into currently empty courts
      estWaitTime = 0;
    } else if (activeCourts.length === 0) {
      // No active matches to base an estimate on — use the assumed duration
      estWaitTime = ASSUMED_MATCH_MINS;
    } else {
      // Estimate average remaining time across active courts using real elapsed data
      const now = Date.now();
      const avgRemainingMins = activeCourts.reduce((sum, c) => {
        const elapsedMins = c.matchStartedAt ? (now - c.matchStartedAt) / 60000 : 0;
        return sum + Math.max(1, ASSUMED_MATCH_MINS - elapsedMins);
      }, 0) / activeCourts.length;

      // How many full court turnovers are needed (each frees activeCourts × 4 slots)
      const turnovers = Math.ceil(remainingWaiting / (activeCourts.length * 4));

      // First turnover waits the averaged remaining time; subsequent ones add a full match
      estWaitTime = Math.ceil(avgRemainingMins + Math.max(0, turnovers - 1) * ASSUMED_MATCH_MINS);
    }
  }

  const allPlayers = [
    ...state.players,
    ...state.lobbies.flatMap(l => l.players.filter(p => p !== null)),
    ...state.courts.flatMap(c => c.players.filter(p => p !== null))
  ];
  const totalActivePlayers = allPlayers.length;

  const skillCounts = { Beginner: 0, Novice: 0, Intermediate: 0, Advanced: 0 };
  allPlayers.forEach(p => {
    if (skillCounts[p.skill] !== undefined) {
      skillCounts[p.skill]++;
    }
  });

  const totalDenom = totalActivePlayers || 1;
  const skillPcts = {
    Beginner: Math.round((skillCounts.Beginner / totalDenom) * 100),
    Novice: Math.round((skillCounts.Novice / totalDenom) * 100),
    Intermediate: Math.round((skillCounts.Intermediate / totalDenom) * 100),
    Advanced: Math.round((skillCounts.Advanced / totalDenom) * 100)
  };

  container.innerHTML = `
    <h3 class="analytics-title">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="color: var(--accent);">
        <path d="M9 19v-6a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2v6a2 2 0 0 0 2 2h2a2 2 0 0 0 2-2zm0 0V9a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v10a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2zm0 0V5a2 2 0 0 1 2-2h2a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2h-2a2 2 0 0 1-2-2z"/>
      </svg>
      Queue Overview
    </h3>
    <div class="stats-grid">
      <div class="stat-card">
        <span class="stat-label">Est. Wait Time</span>
        <span class="stat-val accent-color">${estWaitTime} mins</span>
      </div>
      <div class="stat-card">
        <span class="stat-label">Total Players</span>
        <span class="stat-val">${totalActivePlayers} Active</span>
      </div>
    </div>
    <div class="skill-distribution">
      <div class="skill-bar-item">
        <div class="skill-bar-row">
          <span class="skill-label-indicator">
            <span class="skill-dot" style="background-color: var(--color-beginner);"></span>
            Beginner
          </span>
          <span style="font-weight: 700; color: var(--text-primary);">${skillCounts.Beginner} (${skillPcts.Beginner}%)</span>
        </div>
        <div class="skill-bar-track" style="margin-top: 0.25rem;">
          <div class="skill-bar-fill" style="background: var(--color-beginner); width: ${skillPcts.Beginner}%;"></div>
        </div>
      </div>
      <div class="skill-bar-item">
        <div class="skill-bar-row">
          <span class="skill-label-indicator">
            <span class="skill-dot" style="background-color: var(--color-novice);"></span>
            Novice
          </span>
          <span style="font-weight: 700; color: var(--text-primary);">${skillCounts.Novice} (${skillPcts.Novice}%)</span>
        </div>
        <div class="skill-bar-track" style="margin-top: 0.25rem;">
          <div class="skill-bar-fill" style="background: var(--color-novice); width: ${skillPcts.Novice}%;"></div>
        </div>
      </div>
      <div class="skill-bar-item">
        <div class="skill-bar-row">
          <span class="skill-label-indicator">
            <span class="skill-dot" style="background-color: var(--color-intermediate);"></span>
            Intermediate
          </span>
          <span style="font-weight: 700; color: var(--text-primary);">${skillCounts.Intermediate} (${skillPcts.Intermediate}%)</span>
        </div>
        <div class="skill-bar-track" style="margin-top: 0.25rem;">
          <div class="skill-bar-fill" style="background: var(--color-intermediate); width: ${skillPcts.Intermediate}%;"></div>
        </div>
      </div>
      <div class="skill-bar-item">
        <div class="skill-bar-row">
          <span class="skill-label-indicator">
            <span class="skill-dot" style="background-color: var(--color-advanced);"></span>
            Advanced
          </span>
          <span style="font-weight: 700; color: var(--text-primary);">${skillCounts.Advanced} (${skillPcts.Advanced}%)</span>
        </div>
        <div class="skill-bar-track" style="margin-top: 0.25rem;">
          <div class="skill-bar-fill" style="background: var(--color-advanced); width: ${skillPcts.Advanced}%;"></div>
        </div>
      </div>
    </div>
  `;
}

function renderAdminCourts() {
  const container = document.getElementById('courts-list-container');
  const countLabel = document.getElementById('court-count');
  if (!container) return;
  
  countLabel.textContent = `${state.courts.length} Court${state.courts.length === 1 ? '' : 's'}`;
  
  if (state.courts.length === 0) {
    container.innerHTML = `
      <div class="empty-placeholder">
        <span class="empty-placeholder-icon">🏟️</span>
        <p class="empty-placeholder-text">No courts created. Add a court below.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  state.courts.forEach(court => {
    const isMatch = court.status === 'In Progress';
    const isWarmup = court.status === 'Warm-up';
    const isChallenge = isChallengeGroup(court.players);
    
    let slotsHtml = '';
    for (let s = 0; s < 4; s++) {
      const p = court.players[s];
      if (p) {
        const partner = court.players.find(other => other && other.id !== p.id && other.linkedGroupId && other.linkedGroupId === p.linkedGroupId && other.linkType === 'duo');
        const duoIcon = partner ? `<span style="color: #60a5fa; font-size: 0.75rem; margin-right: 0.2rem;" title="Linked Duo with ${escapeHtml(partner.name)}">🔗</span>` : '';
        
        slotsHtml += `
          <div class="court-player-slot occupied" 
               onclick="handleSlotClick(event, 'court', '${court.id}', ${s})"
               draggable="true"
               ondragstart="handleSlotDragStart(event, '${p.id}', 'court', '${court.id}', ${s})"
               ondragover="handleDragOver(event)"
               ondragenter="handleDragEnter(event)"
               ondragleave="handleDragLeave(event)"
               ondrop="handleDrop(event, 'court', '${court.id}', ${s})">
            <span class="court-player-dot" style="background-color: var(--color-${p.skill.toLowerCase()});"></span>
            <span class="court-player-name" title="${escapeHtml(p.name)}">
              <span class="court-player-name-inner">${duoIcon}${escapeHtml(p.name)}</span>
            </span>
            <span class="badge badge-${p.skill.toLowerCase()}" style="font-size: 0.65rem; padding: 0.1rem 0.3rem; margin-left: auto; flex-shrink: 0;">${SKILL_ABBR[p.skill] || p.skill}</span>
          </div>
        `;
      } else {
        slotsHtml += `
          <div class="court-player-slot" 
               onclick="handleSlotClick(event, 'court', '${court.id}', ${s})"
               ondragover="handleDragOver(event)"
               ondragenter="handleDragEnter(event)"
               ondragleave="handleDragLeave(event)"
               ondrop="handleDrop(event, 'court', '${court.id}', ${s})">
            <span class="court-player-dot" style="background-color: var(--color-empty);"></span>
            <span class="court-player-name" style="color: var(--text-muted);">Empty</span>
          </div>
        `;
      }
    }
    
    // Status text definition
    let statusClass = 'court-status-empty';
    if (isWarmup) statusClass = 'court-status-warmup';
    if (isMatch) statusClass = 'court-status-playing';
    
    // Timer display
    let timerText = '00:00';
    let timerRunningClass = '';
    if (court.matchStartedAt) {
      const seconds = Math.floor((Date.now() - court.matchStartedAt) / 1000);
      const m = Math.floor(seconds / 60).toString().padStart(2, '0');
      const s = (seconds % 60).toString().padStart(2, '0');
      timerText = `${m}:${s}`;
      if (isMatch || isWarmup) timerRunningClass = 'running';
    }
    
    const challengeBadge = isChallenge ? '<span class="challenge-match-badge">🔥 Challenge</span>' : '';
    
    const card = document.createElement('div');
    card.className = `court-card ${isMatch ? 'active-match' : ''}`;
    card.innerHTML = `
      <div class="court-header">
        <div style="display: flex; align-items: center; gap: 0.5rem;">
          <h3 class="court-title">${escapeHtml(court.name)}</h3>
          ${challengeBadge}
          <span class="court-status-badge ${statusClass}">${court.status}</span>
        </div>
        <button class="action-btn delete" title="Delete court" onclick="removeCourt('${court.id}')" style="margin-left: 0.5rem; width: 1.5rem; height: 1.5rem;">×</button>
      </div>
      <div class="court-players">
        ${slotsHtml}
      </div>
      <div class="court-footer">
        <div class="court-timer ${timerRunningClass}" data-court-id="${court.id}" data-started-at="${court.matchStartedAt || ''}">
          <span class="timer-dot"></span>
          <span class="timer-display">${timerText}</span>
        </div>
        <div class="court-actions">
          ${isWarmup ? `
            <button class="court-btn start-btn" onclick="startMatch('${court.id}')">Start Play</button>
          ` : ''}
          ${isMatch || isWarmup ? `
            <button class="court-btn finish-btn" onclick="finishMatch('${court.id}')">Finish Match</button>
          ` : `
            <button class="court-btn start-btn" onclick="loadCourtFromLobby('${court.id}'); saveStateToStorage(); renderUI();">Load Next Up</button>
            <button class="court-btn" onclick="quickClearCourt('${court.id}')" style="margin-left: 0.4rem; border-color: rgba(244, 63, 94, 0.3); color: var(--color-advanced);" title="Quick Clear Court">Clear</button>
          `}
        </div>
      </div>
    `;
    container.appendChild(card);
  });
}

// -- 6.2 LIVEBOARD VIEW RENDERS --

function renderLiveboardCourts() {
  const container = document.getElementById('live-courts-grid-container');
  const dotsContainer = document.getElementById('live-courts-dots');
  if (!container) return;
  
  if (state.courts.length === 0) {
    container.innerHTML = `
      <div class="empty-placeholder" style="grid-column: span 2;">
        <span class="empty-placeholder-icon">🏟️</span>
        <p class="empty-placeholder-text">No active courts setup.</p>
      </div>
    `;
    if (dotsContainer) dotsContainer.innerHTML = '';
    return;
  }
  
  const totalPages = Math.ceil(state.courts.length / liveboardState.courtsPerPage) || 1;
  if (liveboardState.courtPage >= totalPages) {
    liveboardState.courtPage = 0;
  }
  
  container.innerHTML = '';
  
  // Chunk courts into pages of 4
  const pages = [];
  for (let i = 0; i < state.courts.length; i += liveboardState.courtsPerPage) {
    pages.push(state.courts.slice(i, i + liveboardState.courtsPerPage));
  }
  
  pages.forEach(pageCourts => {
    const pageDiv = document.createElement('div');
    pageDiv.className = 'live-court-page';
    
    pageCourts.forEach(court => {
      const isPlaying = court.status === 'In Progress';
      const isWarmup = court.status === 'Warm-up';
      const isChallenge = isChallengeGroup(court.players);
      
      let slotsHtml = '';
      for (let s = 0; s < 4; s++) {
        const p = court.players[s];
        if (p) {
          const partner = court.players.find(other => other && other.id !== p.id && other.linkedGroupId && other.linkedGroupId === p.linkedGroupId && other.linkType === 'duo');
          const duoIcon = partner ? `<span style="color: #60a5fa; font-size: 0.75rem; margin-right: 0.2rem;" title="Linked Duo with ${escapeHtml(partner.name)}">🔗</span>` : '';
          
          slotsHtml += `
            <div class="live-player-slot">
              <span class="live-player-dot" style="background-color: var(--color-${p.skill.toLowerCase()});"></span>
              <span class="court-player-name" title="${escapeHtml(p.name)}">
                <span class="court-player-name-inner">${duoIcon}${escapeHtml(p.name)}</span>
              </span>
              <span class="badge badge-${p.skill.toLowerCase()}" style="font-size: 0.75rem; padding: 0.15rem 0.4rem; margin-left: auto; flex-shrink: 0;">${SKILL_ABBR[p.skill] || p.skill}</span>
            </div>
          `;
        } else {
          slotsHtml += `
            <div class="live-player-slot empty">
              <span>Empty</span>
            </div>
          `;
        }
      }
      
      let statusLabelClass = 'live-status-empty';
      if (isWarmup) statusLabelClass = 'live-status-warmup';
      if (isPlaying) statusLabelClass = 'live-status-playing';
      
      let timerText = '00:00';
      let timerRunningClass = '';
      if (court.matchStartedAt) {
        const seconds = Math.floor((Date.now() - court.matchStartedAt) / 1000);
        const m = Math.floor(seconds / 60).toString().padStart(2, '0');
        const s = (seconds % 60).toString().padStart(2, '0');
        timerText = `${m}:${s}`;
        if (isPlaying || isWarmup) timerRunningClass = 'running';
      }
      
      const fireOverlayHtml = isChallenge ? `
        <div class="fire-bg-animation">
          <div class="flame flame-1"></div>
          <div class="flame flame-2"></div>
          <div class="flame flame-3"></div>
        </div>
      ` : '';
      
      let statusText = court.status === 'In Progress' ? 'MATCH IN PROGRESS' : court.status === 'Warm-up' ? 'WARMING UP' : 'COURT VACANT';
      if (isChallenge && (isPlaying || isWarmup)) {
        statusText = '🔥 CHALLENGE MATCH 🔥';
      }
      
      const card = document.createElement('div');
      card.className = `live-court-card ${isPlaying ? 'active-match' : ''} ${isChallenge ? 'challenge-court' : ''}`;
      card.innerHTML = `
        ${fireOverlayHtml}
        <div class="live-court-header" style="position: relative; z-index: 2;">
          <h3 class="live-court-title">${escapeHtml(court.name)}</h3>
          <div class="live-court-timer ${timerRunningClass}" data-court-id="${court.id}" data-started-at="${court.matchStartedAt || ''}">
            <span class="timer-dot"></span>
            <span class="timer-display" style="font-weight: 800;">${timerText}</span>
          </div>
        </div>
        <div class="live-court-players" style="position: relative; z-index: 2;">
          ${slotsHtml}
        </div>
        <div class="live-court-status ${statusLabelClass}" style="position: relative; z-index: 2;">${statusText}</div>
      `;
      pageDiv.appendChild(card);
    });
    container.appendChild(pageDiv);
  });
  
  // Snap scroll position to active page without animation to preserve state visually
  container.scrollTop = liveboardState.courtPage * container.clientHeight;
  
  // Render pagination dots
  if (dotsContainer) {
    dotsContainer.innerHTML = '';
    if (totalPages > 1) {
      for (let p = 0; p < totalPages; p++) {
        const dot = document.createElement('span');
        dot.className = `dot ${p === liveboardState.courtPage ? 'active' : ''}`;
        dot.title = `Page ${p + 1}`;
        dotsContainer.appendChild(dot);
      }
    }
  }
}

function renderLiveboardLobbies() {
  const container = document.getElementById('live-lobby-grid-container');
  if (!container) return;
  
  if (state.lobbies.length === 0) {
    container.innerHTML = `
      <div class="empty-placeholder" style="padding: 1.5rem;">
        <span class="empty-placeholder-icon">🗂️</span>
        <p class="empty-placeholder-text">No waiting lobbies.</p>
      </div>
    `;
    return;
  }
  
  container.innerHTML = '';
  // Only display the first 2 lobbies on the Liveboard to prevent screen overflow
  const visibleLobbies = state.lobbies.slice(0, 2);
  
  visibleLobbies.forEach((lobby, lIdx) => {
    const isFirst = lIdx === 0;
    const isChallenge = isChallengeGroup(lobby.players);
    
    const card = document.createElement('div');
    card.className = `live-lobby-card ${isFirst ? 'first' : ''} ${isChallenge ? 'challenge-lobby' : ''}`;
    
    let slotsHtml = '';
    for (let s = 0; s < 4; s++) {
      const p = lobby.players[s];
      if (p) {
        const initials = p.name.split(' ').map(n => n[0]).join('').substring(0, 2).toUpperCase();
        const partner = lobby.players.find(other => other && other.id !== p.id && other.linkedGroupId && other.linkedGroupId === p.linkedGroupId && other.linkType === 'duo');
        const duoIcon = partner ? `<span style="color: #60a5fa; font-size: 0.7rem; margin-right: 0.15rem;">🔗</span>` : '';
        
        slotsHtml += `
          <div class="live-lobby-player">
            <span class="live-lobby-initials">${escapeHtml(initials)}</span>
            <span class="live-lobby-name">${duoIcon}${escapeHtml(p.name)}</span>
            <span class="badge badge-${p.skill.toLowerCase()}" style="font-size: 0.55rem; padding: 0.05rem 0.2rem; position: absolute; top: 2px; right: 2px;">${SKILL_ABBR[p.skill] || p.skill}</span>
            <span class="slot-indicator" style="background-color: var(--color-${p.skill.toLowerCase()});"></span>
          </div>
        `;
      } else {
        slotsHtml += `
          <div class="live-lobby-player empty">
            <span style="font-size: 1.5rem; font-weight: 300;">-</span>
          </div>
        `;
      }
    }
    
    const titleText = isChallenge ? `🔥 ${lobby.name} (Challenge)` : lobby.name;
    
    card.innerHTML = `
      <div class="live-lobby-header">
        <span class="live-lobby-title">${escapeHtml(titleText)}</span>
      </div>
      <div class="live-lobby-players">
        ${slotsHtml}
      </div>
    `;
    container.appendChild(card);
  });
}

function renderLiveboardQueue() {
  const container = document.getElementById('live-queue-list-container');
  const countLabel = document.getElementById('live-queue-count');
  const dotsContainer = document.getElementById('live-queue-dots');
  if (!container) return;
  
  countLabel.textContent = `${state.players.length} Player${state.players.length === 1 ? '' : 's'}`;
  
  if (state.players.length === 0) {
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted); font-size: 0.85rem; padding: 1.5rem 0;">
        All checked-in players are currently assigned.
      </div>
    `;
    if (dotsContainer) dotsContainer.innerHTML = '';
    return;
  }
  
  // Calculate paging details
  const totalPages = Math.ceil(state.players.length / liveboardState.queuePerPage) || 1;
  if (liveboardState.queuePage >= totalPages) {
    liveboardState.queuePage = 0;
  }
  
  // Slice to active page chunk
  const activeChunk = state.players.slice(
    liveboardState.queuePage * liveboardState.queuePerPage,
    (liveboardState.queuePage + 1) * liveboardState.queuePerPage
  );
  
  container.innerHTML = '';
  activeChunk.forEach(player => {
    const playerRow = document.createElement('div');
    playerRow.className = 'live-queue-player';
    playerRow.innerHTML = `
      <span class="live-queue-name" title="${escapeHtml(player.name)}">
        <span class="live-queue-name-inner">${escapeHtml(player.name)}</span>
      </span>
      <span class="badge badge-${player.skill.toLowerCase()}">${SKILL_ABBR[player.skill] || player.skill}</span>
    `;
    container.appendChild(playerRow);
  });
  
  // Render pagination dots
  if (dotsContainer) {
    dotsContainer.innerHTML = '';
    if (totalPages > 1) {
      for (let p = 0; p < totalPages; p++) {
        const dot = document.createElement('span');
        dot.className = `dot ${p === liveboardState.queuePage ? 'active' : ''}`;
        dot.title = `Page ${p + 1}`;
        dotsContainer.appendChild(dot);
      }
    }
  }
}

// Auto-paging loop handlers
function runLiveboardCourtPaging() {
  if (currentView !== 'liveboard') return;

  const totalCourtPages = Math.ceil(state.courts.length / liveboardState.courtsPerPage);
  if (totalCourtPages > 1) {
    const nextCourtPage = (liveboardState.courtPage + 1) % totalCourtPages;
    const courtsContainer = document.getElementById('live-courts-grid-container');
    if (courtsContainer) {
      liveboardState.courtPage = nextCourtPage;
      courtsContainer.scrollTo({ top: nextCourtPage * courtsContainer.clientHeight, behavior: 'smooth' });
      
      // Update dots manually instead of completely rebuilding the DOM which aborts scroll animation
      const dotsContainer = document.getElementById('live-courts-dots');
      if (dotsContainer) {
        Array.from(dotsContainer.children).forEach((dot, index) => {
          if (index === nextCourtPage) dot.classList.add('active');
          else dot.classList.remove('active');
        });
      }
    }
  }
}

function runLiveboardSidePanelPaging() {
  if (currentView !== 'liveboard') return;

  const sidePanel = document.getElementById('liveboard-side-panel');
  const lobbiesView = document.getElementById('live-lobbies-view');
  const queueView = document.getElementById('live-queue-view');
  
  if (!sidePanel || !lobbiesView || !queueView) return;

  const totalQueuePages = Math.ceil(state.players.length / liveboardState.queuePerPage) || 1;

  sidePanel.classList.add('fade-out');
  
  setTimeout(() => {
    if (liveboardState.sideView === 'lobbies') {
      // Switch to Queue (Page 0)
      if (state.players.length > 0) {
        liveboardState.sideView = 'queue';
        liveboardState.queuePage = 0;
        lobbiesView.style.display = 'none';
        queueView.style.display = 'flex';
        renderLiveboardQueue();
      }
    } else {
      // We are in Queue. Check if more pages.
      if (liveboardState.queuePage + 1 < totalQueuePages) {
        liveboardState.queuePage++;
        renderLiveboardQueue();
      } else {
        // End of Queue -> Switch back to Lobbies
        liveboardState.sideView = 'lobbies';
        queueView.style.display = 'none';
        lobbiesView.style.display = 'flex';
        renderLiveboardLobbies();
      }
    }
    sidePanel.classList.remove('fade-out');
  }, 300);
}

// -- 6.3 ACTIVE MATCH TIMER CLOCKS (RUNNING DYNAMICALLY WITHOUT RE-RENDERS) --
function updateActiveMatchClocks() {
  const activeTimers = document.querySelectorAll('.court-timer.running, .live-court-timer.running');
  activeTimers.forEach(timerEl => {
    const startedStr = timerEl.getAttribute('data-started-at');
    if (!startedStr) return;
    
    const startedAt = parseInt(startedStr, 10);
    const seconds = Math.floor((Date.now() - startedAt) / 1000);
    const m = Math.floor(seconds / 60).toString().padStart(2, '0');
    const s = (seconds % 60).toString().padStart(2, '0');
    
    const displayEl = timerEl.querySelector('.timer-display');
    if (displayEl) {
      displayEl.textContent = `${m}:${s}`;
    }
  });
}

// Dynamic relative duration tags update for Checked-in Queue
function updateCheckedInTimes() {
  const timeLabels = document.querySelectorAll('.time-ago');
  timeLabels.forEach(el => {
    const checkedInAtStr = el.getAttribute('data-checked-in-at');
    if (!checkedInAtStr) return;
    
    const checkedInAt = parseInt(checkedInAtStr, 10);
    const minAgo = Math.floor((Date.now() - checkedInAt) / 60000);
    el.textContent = minAgo === 0 ? 'just now' : `${minAgo}m ago`;
  });
}

// Dynamically calculates text marquee overflow and applies animation parameters
function applyMarqueeProperties() {
  const configs = [
    { containerSel: '.court-player-name', innerSel: '.court-player-name-inner' },
    { containerSel: '.player-name', innerSel: '.player-name-inner' },
    { containerSel: '.live-queue-name', innerSel: '.live-queue-name-inner' }
  ];

  configs.forEach(cfg => {
    const containers = document.querySelectorAll(cfg.containerSel);
    containers.forEach(container => {
      const inner = container.querySelector(cfg.innerSel);
      if (inner) {
        const overflowAmount = inner.scrollWidth - container.clientWidth;
        if (overflowAmount > 0) {
          container.style.setProperty('--scroll-dist', `-${overflowAmount + 8}px`);
          const duration = Math.max(4, 4 + (overflowAmount / 20));
          container.style.setProperty('--scroll-duration', `${duration}s`);
          container.classList.add('can-scroll');
        } else {
          container.style.setProperty('--scroll-dist', `0px`);
          container.style.setProperty('--scroll-duration', `0s`);
          container.classList.remove('can-scroll');
        }
      }
    });
  });
}

// Recalculates page sizes dynamically based on screen real estate
function recalculateLiveboardCapacities() {
  if (currentView !== 'liveboard') return;
  
  // 1. Calculate Courts Grid Capacity
  // Fixed at 4 courts per page for Liveboard
  liveboardState.courtsPerPage = 4;
  const totalPages = Math.ceil(state.courts.length / liveboardState.courtsPerPage) || 1;
  if (liveboardState.courtPage >= totalPages) {
    liveboardState.courtPage = 0;
  }
  
  // 2. Calculate Waiting List Capacity
  const queueList = document.getElementById('live-queue-list-container');
  if (queueList) {
    const listWidth = queueList.clientWidth || window.innerWidth * 0.3;
    const listHeight = queueList.clientHeight || window.innerHeight * 0.7;
    
    // Estimate tile size (avg width 130px, height 48px)
    const cols = Math.max(1, Math.floor(listWidth / 130));
    const rows = Math.max(1, Math.floor(listHeight / 48));
    
    const newQueuePerPage = cols * rows;
    
    if (newQueuePerPage > 0 && newQueuePerPage !== liveboardState.queuePerPage) {
      liveboardState.queuePerPage = newQueuePerPage;
      const totalPages = Math.ceil(state.players.length / liveboardState.queuePerPage) || 1;
      if (liveboardState.queuePage >= totalPages) {
        liveboardState.queuePage = 0;
      }
    }
  }
}

// Window resize listener
window.addEventListener('resize', () => {
  if (currentView === 'liveboard') {
    recalculateLiveboardCapacities();
    renderUI();
  }
});

// Drag and Drop & Click assignment logic

function togglePlayerSelection(event, playerId) {
  // If clicked on action buttons, do nothing
  if (event.target.closest('.player-actions')) {
    return;
  }
  
  if (selectedPlayerId === playerId) {
    selectedPlayerId = null;
  } else {
    selectedPlayerId = playerId;
  }
  
  renderUI();
}

function handleDragStart(event, playerId) {
  event.dataTransfer.setData('text/plain', playerId);
  event.dataTransfer.effectAllowed = 'move';
}

function handleSlotDragStart(event, playerId, sourceType, sourceTargetId, sourceSlotIndex) {
  event.dataTransfer.setData('text/plain', playerId);
  event.dataTransfer.setData('sourceType', sourceType);
  event.dataTransfer.setData('sourceTargetId', sourceTargetId);
  event.dataTransfer.setData('sourceSlotIndex', sourceSlotIndex);
  event.dataTransfer.effectAllowed = 'move';
}

function handleDragOver(event) {
  event.preventDefault();
  event.dataTransfer.dropEffect = 'move';
}

function handleDragEnter(event) {
  event.preventDefault();
  event.currentTarget.classList.add('drag-hover');
}

function handleDragLeave(event) {
  event.currentTarget.classList.remove('drag-hover');
}

function handleDrop(event, targetType, targetId, targetSlotIndex) {
  event.preventDefault();
  event.currentTarget.classList.remove('drag-hover');
  
  const playerId = event.dataTransfer.getData('text/plain');
  const sourceType = event.dataTransfer.getData('sourceType');
  const sourceTargetId = event.dataTransfer.getData('sourceTargetId');
  const sourceSlotIndexStr = event.dataTransfer.getData('sourceSlotIndex');
  
  if (!playerId) return;
  
  // Find the player object
  const player = findGlobalPlayerById(playerId);
  if (!player) return;
  
  if (sourceType) {
    // Slot-to-slot move
    const sourceSlotIndex = parseInt(sourceSlotIndexStr, 10);
    
    // Find source container (court or lobby)
    let sourceContainer;
    if (sourceType === 'court') {
      sourceContainer = state.courts.find(c => c.id === sourceTargetId);
    } else {
      sourceContainer = state.lobbies.find(l => l.id === sourceTargetId);
    }
    
    // Find target container
    let targetContainer;
    if (targetType === 'court') {
      targetContainer = state.courts.find(c => c.id === targetId);
    } else {
      targetContainer = state.lobbies.find(l => l.id === targetId);
    }
    
    if (sourceContainer && targetContainer) {
      // Swap or Move
      const temp = targetContainer.players[targetSlotIndex];
      targetContainer.players[targetSlotIndex] = sourceContainer.players[sourceSlotIndex];
      sourceContainer.players[sourceSlotIndex] = temp;
      
      // Update statuses if they are courts
      if (sourceType === 'court') {
        const count = sourceContainer.players.filter(p => p !== null).length;
        if (count === 0) {
          sourceContainer.status = 'Empty';
          sourceContainer.matchStartedAt = null;
        } else if (sourceContainer.status === 'Empty') {
          sourceContainer.status = 'Warm-up';
          sourceContainer.matchStartedAt = Date.now();
        }
      }
      if (targetType === 'court') {
        const count = targetContainer.players.filter(p => p !== null).length;
        if (count === 0) {
          targetContainer.status = 'Empty';
          targetContainer.matchStartedAt = null;
        } else if (targetContainer.status === 'Empty') {
          targetContainer.status = 'Warm-up';
          targetContainer.matchStartedAt = Date.now();
        }
      }
    }
  } else {
    // Queue-to-slot move
    // Remove from queue
    state.players = state.players.filter(p => p.id !== playerId);
    
    // Find target container
    let targetContainer;
    if (targetType === 'court') {
      targetContainer = state.courts.find(c => c.id === targetId);
    } else {
      targetContainer = state.lobbies.find(l => l.id === targetId);
    }
    
    if (targetContainer) {
      const oldOccupant = targetContainer.players[targetSlotIndex];
      if (oldOccupant) {
        state.players.push(oldOccupant);
      }
      targetContainer.players[targetSlotIndex] = player;
      
      if (targetType === 'court') {
        const count = targetContainer.players.filter(p => p !== null).length;
        if (targetContainer.status === 'Empty' && count > 0) {
          targetContainer.status = 'Warm-up';
          targetContainer.matchStartedAt = Date.now();
        }
      }
    }
  }
  
  // Clear selection if the dragged player was selected
  if (selectedPlayerId === playerId) {
    selectedPlayerId = null;
  }
  
  saveStateToStorage();
  renderUI();
}

function handleSlotClick(event, type, targetId, slotIndex) {
  event.stopPropagation();
  
  if (selectedPlayerId) {
    // Direct assign
    const player = state.players.find(p => p.id === selectedPlayerId);
    if (player) {
      assignPlayerToSlotDirect(selectedPlayerId, type, targetId, slotIndex);
    }
    selectedPlayerId = null;
  } else {
    // Open normal modal search
    openAssignModal(type, targetId, slotIndex);
  }
}

function assignPlayerToSlotDirect(playerId, type, targetId, slotIndex) {
  const player = state.players.find(p => p.id === playerId);
  if (!player) return;
  
  // Remove player from queue
  state.players = state.players.filter(p => p.id !== playerId);
  
  if (type === 'court') {
    const court = state.courts.find(c => c.id === targetId);
    if (court) {
      const oldOccupant = court.players[slotIndex];
      if (oldOccupant) {
        state.players.push(oldOccupant);
      }
      court.players[slotIndex] = player;
      
      const count = court.players.filter(p => p !== null).length;
      if (court.status === 'Empty' && count > 0) {
        court.status = 'Warm-up';
        court.matchStartedAt = Date.now();
      }
    }
  } else {
    // lobby slot
    const lobby = state.lobbies.find(l => l.id === targetId);
    if (lobby) {
      const oldOccupant = lobby.players[slotIndex];
      if (oldOccupant) {
        state.players.push(oldOccupant);
      }
      lobby.players[slotIndex] = player;
    }
  }
  
  saveStateToStorage();
  renderUI();
}

// Make globally accessible inside HTML inline click listeners
window.removePlayer = removePlayer;
window.openEditPlayerModal = openEditPlayerModal;
window.openAssignModal = openAssignModal;
window.startMatch = startMatch;
window.finishMatch = finishMatch;
window.loadCourtFromLobby = loadCourtFromLobby;
window.saveStateToStorage = saveStateToStorage;
window.renderUI = renderUI;
window.togglePlayerSelection = togglePlayerSelection;
window.handleDragStart = handleDragStart;
window.handleDragOver = handleDragOver;
window.handleDragEnter = handleDragEnter;
window.handleDragLeave = handleDragLeave;
window.handleDrop = handleDrop;
window.handleSlotClick = handleSlotClick;
window.handleSlotDragStart = handleSlotDragStart;

window.quickClearLobby = function(lobbyId) {
  const lobby = state.lobbies.find(l => l.id === lobbyId);
  if (!lobby) return;
  lobby.players.forEach(p => {
    if (p) state.players.push(p);
  });
  lobby.players = [null, null, null, null];
  saveStateToStorage();
  renderUI();
}

window.quickClearCourt = function(courtId) {
  const court = state.courts.find(c => c.id === courtId);
  if (!court) return;
  court.players.forEach(p => {
    if (p) state.players.push(p);
  });
  court.players = [null, null, null, null];
  court.status = 'Empty';
  court.matchStartedAt = null;
  saveStateToStorage();
  renderUI();
}

window.renderAdminEditPlayersList = function() {
  const listContainer = document.getElementById('all-players-list-container');
  if (!listContainer) return;
  
  listContainer.innerHTML = '';
  
  if (state.players.length === 0) {
    listContainer.innerHTML = '<div style="text-align: center; color: var(--text-muted); padding: 1rem;">No players are currently in the queue.</div>';
  } else {
    state.players.forEach(p => {
      const checkedInTime = p.checkedInAt || Date.now();
      const minAgo = Math.floor((Date.now() - checkedInTime) / 60000);
      const minText = minAgo === 0 ? 'just now' : `${minAgo}m ago`;
      const card = document.createElement('div');
      card.className = 'player-card-compact';
      card.style.cursor = 'default';
      card.innerHTML = `
        <div class="player-info-row">
          <span class="player-name" title="${escapeHtml(p.name)}">
            <span class="player-name-inner">${escapeHtml(p.name)}</span>
          </span>
          <span class="badge badge-${p.skill.toLowerCase()}">${SKILL_ABBR[p.skill] || p.skill}</span>
        </div>
        <div class="player-actions-compact" style="display: flex; align-items: center; gap: 0.75rem; flex-shrink: 0; margin-left: 1rem;">
          <span class="time-ago" data-checked-in-at="${checkedInTime}" style="font-size: 0.75rem; color: var(--text-muted);">${minText}</span>
          <div class="player-actions" style="display: flex; gap: 0.25rem;">
            <button class="action-btn" title="Edit player details" onclick="event.stopPropagation(); openEditPlayerModal('${p.id}')">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7M18.5 2.5a2.121 2.121 0 1 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
              </svg>
            </button>
            <button class="action-btn delete" title="Check out player" onclick="event.stopPropagation(); removePlayer('${p.id}')">
              <svg width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24">
                <path d="M19 7l-.867 12.142A2 2 0 0 1 16.138 21H7.862a2 2 0 0 1-1.995-1.858L5 7m5 4v6m4-6v6m1-10V4a1 1 0 0 0-1-1h-4a1 1 0 0 0-1 1v3M4 7h16"/>
              </svg>
            </button>
          </div>
        </div>
      `;
      listContainer.appendChild(card);
    });
  }
  
  // Recalculate marquee animations for the players rendered
  applyMarqueeProperties();
}

// -------------------------------------------------------------
// 7. Matchmaking Engine
// -------------------------------------------------------------

/**
 * Returns the individual effective priority timestamp for a player.
 */
function getPlayerPriorityIndividual(player) {
  const games = player.gamesPlayedToday || 0;
  const waitTime = player.lastPlayedAt || player.checkedInAt || Date.now();
  return (games * 10000000000000) + waitTime;
}

/**
 * Returns the effective priority timestamp for a player.
 * Lower value = higher priority.
 * If a player is linked, returns the worst priority of their group.
 */
function getPlayerPriority(player) {
  if (!player.linkedGroupId) {
    return getPlayerPriorityIndividual(player);
  }
  // Find all players in the checked-in queue with this group ID
  const groupPlayers = state.players.filter(p => p.linkedGroupId === player.linkedGroupId);
  if (groupPlayers.length === 0) {
    return getPlayerPriorityIndividual(player);
  }
  // Use the worst priority (max number value) to be fair to solos
  return Math.max(...groupPlayers.map(p => getPlayerPriorityIndividual(p)));
}

/**
 * Returns effective skill rank with wait-time decay.
 * After 10+ minutes of waiting, the rank shifts toward the center by up to 0.5,
 * making the player eligible for slightly mismatched groups.
 */
function getEffectiveSkillRank(player) {
  const baseRank = SKILL_RANK[player.skill] ?? 1;
  const waitMins = (Date.now() - getPlayerPriority(player)) / 60000;
  if (waitMins > 10) {
    const shift = Math.min(0.5, (waitMins - 10) / 20);
    // Shift toward center rank (1.5)
    return baseRank < 1.5 ? baseRank + shift : baseRank - shift;
  }
  return baseRank;
}

/**
 * Scores a group of 4 players using Team Synergy Balancing.
 * Lower score = more balanced + diverse = higher quality match.
 */
function scoreGroup(group) {
  let score = 0;
  
  if (group.length === 4) {
    // Sort players by skill to pair highest+lowest vs middle two
    const sorted = [...group].sort((a, b) => getEffectiveSkillRank(a) - getEffectiveSkillRank(b));
    const teamA = getEffectiveSkillRank(sorted[0]) + getEffectiveSkillRank(sorted[3]);
    const teamB = getEffectiveSkillRank(sorted[1]) + getEffectiveSkillRank(sorted[2]);
    
    // Skill difference penalty between teams (Primary factor)
    score += Math.abs(teamA - teamB) * 100;
  }
  
  // Diversity penalty: penalize for ANY players in the group who played recently
  for (let i = 0; i < group.length; i++) {
    for (let j = i + 1; j < group.length; j++) {
      const p1 = group[i];
      const p2 = group[j];
      
      if (p1.recentlyPlayedWith && p1.recentlyPlayedWith.includes(p2.id)) {
        score += 15;
      }
    }
  }
  
  return score;
}

/**
 * Groups checked-in players into party structures (solos, duos, challenges)
 * to maintain linked party integrity.
 */
function getParties(players) {
  const parties = [];
  const visited = new Set();
  
  players.forEach(p => {
    if (visited.has(p.id)) return;
    
    if (p.linkedGroupId) {
      const groupPlayers = players.filter(other => other.linkedGroupId === p.linkedGroupId);
      groupPlayers.forEach(other => visited.add(other.id));
      
      if (p.linkType === 'challenge') {
        if (groupPlayers.length === 4) {
          parties.push({
            id: p.linkedGroupId,
            type: 'challenge',
            players: groupPlayers
          });
        } else {
          // Incomplete challenge: treat members as solos so they aren't stuck
          groupPlayers.forEach(gp => {
            parties.push({
              id: gp.id,
              type: 'solo',
              players: [gp]
            });
          });
        }
      } else if (p.linkType === 'duo') {
        if (groupPlayers.length === 2) {
          parties.push({
            id: p.linkedGroupId,
            type: 'duo',
            players: groupPlayers
          });
        } else {
          // Incomplete duo: treat partner as solo
          groupPlayers.forEach(gp => {
            parties.push({
              id: gp.id,
              type: 'solo',
              players: [gp]
            });
          });
        }
      } else {
        groupPlayers.forEach(gp => {
          parties.push({
            id: gp.id,
            type: 'solo',
            players: [gp]
          });
        });
      }
    } else {
      visited.add(p.id);
      parties.push({
        id: p.id,
        type: 'solo',
        players: [p]
      });
    }
  });
  
  parties.forEach(party => {
    party.priority = Math.max(...party.players.map(p => getPlayerPriority(p)));
  });
  
  return parties;
}

/**
 * Backtracking helper to find candidate parties that sum up to target size.
 */
function findPartyCombinations(candidates, targetSize) {
  const results = [];
  
  function backtrack(index, currentCombo, currentSize) {
    if (currentSize === targetSize) {
      results.push([...currentCombo]);
      return;
    }
    if (currentSize > targetSize || index >= candidates.length) {
      return;
    }
    
    // Include candidates[index]
    const party = candidates[index];
    currentCombo.push(party);
    backtrack(index + 1, currentCombo, currentSize + party.players.length);
    currentCombo.pop();
    
    // Exclude candidates[index]
    backtrack(index + 1, currentCombo, currentSize);
  }
  
  backtrack(0, [], 0);
  return results;
}

/**
 * Core matchmaking algorithm (Party-Based Matchmaking).
 * Evaluates combinations to find best matches prioritizing skill then diversity.
 */
function buildMatchGroups(players) {
  let parties = getParties(players);
  
  // Sort parties by priority (lower priority value = higher priority)
  parties.sort((a, b) => a.priority - b.priority);
  
  const groups = [];
  
  while (parties.length > 0) {
    const totalPlayersLeft = parties.reduce((sum, p) => sum + p.players.length, 0);
    if (totalPlayersLeft < 4) break;
    
    const seedParty = parties[0];
    let bestCombination = null;
    let bestScore = Infinity;
    
    if (seedParty.type === 'challenge') {
      // Challenge group forms a match immediately
      groups.push(seedParty.players);
      parties.shift();
      continue;
    }
    
    const neededSlots = 4 - seedParty.players.length; // 2 for duo, 3 for solo
    
    // Candidates are the next 15 parties
    const candidates = parties.slice(1, 16);
    
    const validCombos = findPartyCombinations(candidates, neededSlots);
    
    if (validCombos.length === 0) {
      // Fallback: search all remaining parties
      const allCandidates = parties.slice(1);
      const fallbackCombos = findPartyCombinations(allCandidates, neededSlots);
      if (fallbackCombos.length > 0) {
        bestCombination = fallbackCombos[0];
      } else {
        // Defer the seed party to prevent infinite loop
        parties.shift();
        continue;
      }
    } else {
      // Find the combination that gives the best (lowest) match score
      for (const combo of validCombos) {
        const group = [...seedParty.players];
        combo.forEach(party => group.push(...party.players));
        
        const score = scoreGroup(group);
        if (score < bestScore) {
          bestScore = score;
          bestCombination = combo;
        }
        if (bestScore === 0) break; // short-circuit
      }
    }
    
    if (bestCombination) {
      const group = [...seedParty.players];
      bestCombination.forEach(party => group.push(...party.players));
      groups.push(group);
      
      // Remove selected parties
      const selectedPartyIds = new Set([seedParty.id, ...bestCombination.map(p => p.id)]);
      parties = parties.filter(p => !selectedPartyIds.has(p.id));
    } else {
      // Defer the seed party to prevent infinite loop
      parties.shift();
    }
  }
  
  return groups;
}

// -------------------------------------------------------------
// 8. Automation Pipeline
// -------------------------------------------------------------

function startAutomation() {
  if (isStandalone) return;
  automationEnabled = true;
  localStorage.setItem('queuepilot_automation', 'true');
  if (automationIntervalId) clearInterval(automationIntervalId);
  automationIntervalId = setInterval(runAutomationTick, AUTOMATION_TICK_MS);
  runAutomationTick(); // Run immediately on enable
  logAutomationAction('SYSTEM', 'Automation enabled');
  updateToggleCheckbox();
  renderUI();
}

function stopAutomation() {
  automationEnabled = false;
  localStorage.setItem('queuepilot_automation', 'false');
  if (automationIntervalId) {
    clearInterval(automationIntervalId);
    automationIntervalId = null;
  }
  logAutomationAction('SYSTEM', 'Automation disabled');
  updateToggleCheckbox();
  renderUI();
}

function restoreAutomationState() {
  if (isStandalone) return;
  const saved = localStorage.getItem('queuepilot_automation');
  if (saved === 'true') {
    automationEnabled = true;
    automationIntervalId = setInterval(runAutomationTick, AUTOMATION_TICK_MS);
    updateToggleCheckbox();
  }
}

function updateToggleCheckbox() {
  const toggle = document.getElementById('toggle-automation');
  if (toggle) toggle.checked = automationEnabled;
}

function logAutomationAction(action, detail) {
  automationLog.unshift({
    timestamp: Date.now(),
    action: action,
    detail: detail
  });
  // Cap log at 20 entries
  if (automationLog.length > 20) automationLog.length = 20;
}

/**
 * Main automation tick — runs every AUTOMATION_TICK_MS when automation is ON.
 * Pipeline: Start Matches → Promote Lobbies → Fill Lobbies
 * Note: Processes ONE action per tick to create gradual pacing.
 */
function runAutomationTick() {
  if (!automationEnabled) return;
  
  // Priority 1: Auto-start Warm-up courts to In Progress
  const courtToStart = state.courts.find(c => c.status === 'Warm-up');
  if (courtToStart) {
    courtToStart.status = 'In Progress';
    courtToStart.matchStartedAt = Date.now();
    logAutomationAction('MATCH_START', `Started match on ${courtToStart.name}`);
    saveStateToStorage();
    renderUI();
    return; // Exit tick for staggered pacing
  }
  
  // Priority 2: Promote Lobby 1 to empty courts (must have 4 players)
  const emptyCourt = state.courts.find(c => c.status === 'Empty');
  const lobby1 = state.lobbies[0];
  if (emptyCourt && lobby1 && lobby1.players.filter(p => p !== null).length === 4) {
    // Move lobby 1 players to court
    for (let i = 0; i < 4; i++) {
      emptyCourt.players[i] = lobby1.players[i];
    }
    emptyCourt.status = 'Warm-up';
    emptyCourt.matchStartedAt = Date.now();
    
    logAutomationAction('COURT_LOAD', `Loaded ${emptyCourt.name} from ${lobby1.name}`);
    
    // Shift lobbies forward
    shiftLobbies();
    saveStateToStorage();
    renderUI();
    return; // Exit tick for staggered pacing
  }
  
  // Priority 3: Fill empty lobbies with matchmade groups
  const emptyLobby = state.lobbies.find(l => l.players.every(p => p === null));
  if (emptyLobby) {
    const groups = buildMatchGroups(state.players);
    if (groups.length > 0) {
      const group = groups[0];
      if (group.length === 4) {
        for (let i = 0; i < 4; i++) {
          emptyLobby.players[i] = group[i] || null;
        }
        // Remove assigned players from queue
        const assignedIds = new Set(group.map(p => p.id));
        state.players = state.players.filter(p => !assignedIds.has(p.id));
        
        const skillSummary = group.map(p => SKILL_ABBR[p.skill]).join(', ');
        logAutomationAction('LOBBY_FILL', `Filled ${emptyLobby.name}: ${skillSummary}`);
        saveStateToStorage();
        renderUI();
        return; // Exit tick for staggered pacing
      }
    }
  }
}

// -------------------------------------------------------------
// 9. Automation Log Renderer
// -------------------------------------------------------------
function renderAutomationLog() {
  const container = document.getElementById('automation-log-container');
  if (!container) return;
  
  container.style.display = 'flex';
  container.style.flexDirection = 'column';
  container.style.height = '100%';
  
  if (!automationEnabled) {
    container.style.justifyContent = 'center';
    container.style.alignItems = 'center';
    container.innerHTML = `
      <div style="text-align: center; color: var(--text-muted);">
        <svg width="32" height="32" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="margin-bottom: 0.5rem; opacity: 0.5; display: inline-block;">
          <path stroke-linecap="round" stroke-linejoin="round" d="M18.364 18.364A9 9 0 0 0 5.636 5.636m12.728 12.728A9 9 0 0 1 5.636 5.636m12.728 12.728L5.636 5.636" />
        </svg>
        <p style="font-family: var(--font-heading); font-weight: 600; font-size: 1.1rem; color: var(--text-secondary);">Automation Disabled</p>
        <p style="font-size: 0.8rem; margin-top: 0.25rem;">Toggle automation in the header to view logs.</p>
      </div>
    `;
    return;
  }
  
  container.style.justifyContent = 'flex-start';
  container.style.alignItems = 'stretch';
  
  if (automationLog.length === 0) {
    container.innerHTML = `
      <h3 class="analytics-title">
        <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="color: var(--accent);">
          <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
        </svg>
        Automation Log
      </h3>
      <div style="text-align: center; color: var(--text-muted); font-size: 0.75rem; padding: 0.5rem;">Waiting for automation actions...</div>
    `;
    return;
  }
  
  const entries = automationLog.slice(0, 10).map(entry => {
    const time = new Date(entry.timestamp);
    const timeStr = time.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' });
    const actionClass = entry.action.toLowerCase().replace('_', '-');
    return `<div class="auto-log-entry auto-log-${actionClass}">
      <span class="auto-log-time">${timeStr}</span>
      <span class="auto-log-detail">${escapeHtml(entry.detail)}</span>
    </div>`;
  }).join('');
  
  container.innerHTML = `
    <h3 class="analytics-title">
      <svg width="16" height="16" fill="none" stroke="currentColor" stroke-width="2" viewBox="0 0 24 24" style="color: var(--accent);">
        <path d="M12 8v4l3 3m6-3a9 9 0 1 1-18 0 9 9 0 0 1 18 0z"/>
      </svg>
      Automation Log
    </h3>
    <div class="auto-log-list">${entries}</div>
  `;
}
