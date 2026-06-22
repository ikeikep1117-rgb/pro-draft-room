import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import { getAuth, signInAnonymously, onAuthStateChanged } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  getFirestore, collection, doc, addDoc, setDoc, getDoc, getDocs, updateDoc, deleteDoc,
  onSnapshot, query, orderBy, serverTimestamp, runTransaction, writeBatch,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";
import { selectDefaultPlayers } from "./default-players.js";
import { MLB_ACTIVE_2026, NPB_STAFF_2026 } from "./preset-templates.js";

const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const state = {
  user: null, roomId: null, room: null, members: [], players: [], picks: [],
  myNomination: null, lotteryChoices: [], unsubs: [], filter: "all", search: "",
  editingPlayerId: null, historyMemberId: null, announcementTimer: null,
  revealDelayTimer: null, renderedAnnouncement: "",
};
let db;
let auth;
const customTemplateKey = "draft-room-custom-templates";
const configured = !Object.values(firebaseConfig).some((v) => String(v).includes("YOUR_"));

if (configured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  signInAnonymously(auth).catch(showError);
  onAuthStateChanged(auth, (user) => { state.user = user; restoreSession(); });
} else {
  $("#setup-note").textContent = "Firebaseの設定が未入力です。firebase-config.js を編集してください。";
}

function toast(message) {
  $("#toast").textContent = message;
  $("#toast").classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => $("#toast").classList.remove("show"), 2600);
}
function showError(error) {
  console.error(error);
  const map = {
    "auth/operation-not-allowed": "Firebaseで匿名認証を有効にしてください。",
    "permission-denied": "Firestoreの権限設定を確認してください。",
  };
  toast(map[error?.code] || error?.message || "処理に失敗しました。");
}
function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;" })[c]);
}
function normalizeName(value = "") { return value.normalize("NFKC").toLowerCase().replace(/[\s・.]/g, ""); }
function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}
function roomRef() { return doc(db, "rooms", state.roomId); }
function isHost() { return state.room?.hostId === state.user?.uid; }
function currentMember() { return state.members.find((m) => m.id === state.user?.uid); }
function currentAttempt() { return state.room?.attempt || 1; }
function activeMembers() {
  const ids = state.room?.eligibleMemberIds;
  return state.members.filter((m) => !m.finished && (!ids?.length || ids.includes(m.id)));
}
function hasSubmitted(member) {
  return member.hasSubmitted && member.nominationRound === state.room?.round && member.nominationAttempt === currentAttempt();
}
function pickedIds() { return new Set(state.picks.map((p) => p.playerId)); }
function currentTurnMember() {
  const active = state.members.filter((m) => !m.finished);
  if (!active.length) return null;
  return active[(state.room?.turnIndex || 0) % active.length];
}
function cleanupListeners() {
  state.unsubs.forEach((u) => u());
  state.unsubs = [];
  clearTimeout(state.announcementTimer);
  clearTimeout(state.revealDelayTimer);
}

function loadCustomTemplates() {
  try { return JSON.parse(localStorage.getItem(customTemplateKey) || "[]"); }
  catch { return []; }
}
function saveCustomTemplates(templates) {
  localStorage.setItem(customTemplateKey, JSON.stringify(templates));
}
function getSelectedTemplatePlayers() {
  const selected = $$('input[name="player-template"]:checked').map((input) => input.value);
  const customTemplates = loadCustomTemplates();
  const groups = selected.flatMap((id) => {
    if (id === "npb-all") return selectDefaultPlayers("all");
    if (id === "central" || id === "pacific") return selectDefaultPlayers(id);
    if (id === "mlb") return MLB_ACTIVE_2026;
    if (id === "npb-staff") return NPB_STAFF_2026;
    return customTemplates.find((template) => template.id === id)?.players || [];
  });
  const unique = new Map();
  groups.forEach((player) => {
    const key = `${normalizeName(player.name)}:${normalizeName(player.team || "")}`;
    if (!unique.has(key)) unique.set(key, player);
  });
  return [...unique.values()];
}
async function addDefaultPlayers(roomId, players) {
  const chunkSize = 400;
  for (let start = 0; start < players.length; start += chunkSize) {
    const batch = writeBatch(db);
    players.slice(start, start + chunkSize).forEach((player) => {
      batch.set(doc(collection(db, "rooms", roomId, "players")), {
        ...player,
        normalizedName: normalizeName(player.name),
        creatorId: state.user.uid,
        createdAt: serverTimestamp(),
      });
    });
    await batch.commit();
  }
  return players.length;
}

function renderCustomTemplates() {
  const templates = loadCustomTemplates();
  $("#custom-template-choices").innerHTML = templates.map((template) => `
    <label><input type="checkbox" name="player-template" value="${escapeHtml(template.id)}"><span><b>${escapeHtml(template.name)}</b><small>マイテンプレート ${template.players.length}名</small></span></label>`).join("");
  $("#saved-template-list").innerHTML = templates.length
    ? `<h4>保存済みテンプレート</h4>${templates.map((template) => `<article><div><b>${escapeHtml(template.name)}</b><span>${template.players.length}名</span></div><button type="button" data-delete-template="${escapeHtml(template.id)}">削除</button></article>`).join("")}`
    : "<p>保存済みテンプレートはありません。</p>";
  $$("[data-delete-template]").forEach((button) => button.addEventListener("click", () => {
    const next = loadCustomTemplates().filter((template) => template.id !== button.dataset.deleteTemplate);
    saveCustomTemplates(next);
    renderCustomTemplates();
    toast("テンプレートを削除しました。");
  }));
}

async function restoreSession() {
  const saved = JSON.parse(localStorage.getItem("draft-room-session") || "null");
  if (!saved || !state.user || saved.userId !== state.user.uid) return;
  const snap = await getDoc(doc(db, "rooms", saved.roomId));
  if (snap.exists()) enterRoom(saved.roomId);
  else localStorage.removeItem("draft-room-session");
}

$$(".tab").forEach((button) => button.addEventListener("click", () => {
  $$(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
  $$(".entry-form").forEach((form) => form.classList.toggle("active", form.id.startsWith(button.dataset.tab)));
}));
renderCustomTemplates();
$("#join-code").addEventListener("input", (e) => { e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9]/g, ""); });
$("#draft-mode").addEventListener("change", (e) => { $("#conflict-mode").disabled = e.target.value === "sequential"; });

$("#template-form").addEventListener("submit", (event) => {
  event.preventDefault();
  const name = $("#template-name").value.trim();
  const lines = $("#template-players").value.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const players = lines.map((line, index) => {
    const [playerName, position = "—", team = "", uniformNumber = ""] = line.split(",").map((value) => value.trim());
    return {
      name: playerName,
      position: position || "—",
      team,
      uniformNumber,
      teamOrder: 500,
      uniformSort: /^\d+$/.test(uniformNumber) ? Number(uniformNumber) : 9000 + index,
      source: "custom-template",
    };
  }).filter((player) => player.name);
  if (!name || !players.length) return toast("テンプレート名と選手を入力してください。");
  const templates = loadCustomTemplates();
  const id = `custom-${Date.now().toString(36)}`;
  templates.push({ id, name, players, createdAt: new Date().toISOString() });
  saveCustomTemplates(templates);
  event.target.reset();
  renderCustomTemplates();
  toast(`${players.length}名のテンプレートを保存しました。`);
});

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured || !state.user) return toast("Firebaseへの接続を確認してください。");
  event.submitter.disabled = true;
  const buttonLabel = event.submitter.querySelector("span");
  const originalLabel = buttonLabel.textContent;
  try {
    buttonLabel.textContent = "部屋を準備しています";
    const rooms = await getDocs(collection(db, "rooms"));
    let code;
    do code = makeCode(); while (rooms.docs.some((d) => d.data().code === code));
    const room = await addDoc(collection(db, "rooms"), {
      code, name: $("#room-name").value.trim(), hostId: state.user.uid, status: "waiting",
      phase: "waiting", draftMode: $("#draft-mode").value, conflictMode: $("#conflict-mode").value,
      selectedTemplates: $$('input[name="player-template"]:checked').map((input) => input.value),
      round: 1, attempt: 1, turnIndex: 0, draftOrder: [], eligibleMemberIds: [],
      announcement: null, revealedPickIds: [], lottery: null, lotteryQueue: [], lotteryIndex: 0,
      lotteryLosers: [], createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "rooms", room.id, "members", state.user.uid), {
      name: $("#create-name").value.trim(), joinedAt: serverTimestamp(), order: 0, isHost: true,
      finished: false, hasSubmitted: false,
    });
    const templatePlayers = getSelectedTemplatePlayers();
    if (templatePlayers.length) {
      buttonLabel.textContent = "選手名簿を登録しています";
      const count = await addDefaultPlayers(room.id, templatePlayers);
      toast(`${count}名の選手を追加しました。`);
    }
    enterRoom(room.id);
  } catch (error) { showError(error); }
  finally {
    event.submitter.disabled = false;
    buttonLabel.textContent = originalLabel;
  }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured || !state.user) return toast("Firebaseへの接続を確認してください。");
  event.submitter.disabled = true;
  try {
    const rooms = await getDocs(collection(db, "rooms"));
    const found = rooms.docs.find((d) => d.data().code === $("#join-code").value.trim().toUpperCase());
    if (!found) return toast("参加コードが見つかりません。");
    const members = await getDocs(collection(db, "rooms", found.id, "members"));
    await setDoc(doc(db, "rooms", found.id, "members", state.user.uid), {
      name: $("#join-name").value.trim(), joinedAt: serverTimestamp(), order: members.size,
      isHost: false, finished: false, hasSubmitted: false,
    });
    enterRoom(found.id);
  } catch (error) { showError(error); }
  finally { event.submitter.disabled = false; }
});

function enterRoom(roomId) {
  cleanupListeners();
  state.roomId = roomId;
  localStorage.setItem("draft-room-session", JSON.stringify({ roomId, userId: state.user.uid }));
  $("#landing").classList.add("hidden");
  $("#room").classList.remove("hidden");
  state.unsubs.push(
    onSnapshot(roomRef(), (snap) => {
      if (!snap.exists()) return leaveRoom();
      state.room = { id: snap.id, ...snap.data() };
      if (!state.room.phase) state.room.phase = state.room.status === "waiting" ? "waiting" : "nomination";
      render();
      renderAnnouncement();
      renderLottery();
      renderFinalResults();
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "members"), orderBy("order")), (snap) => {
      state.members = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
      renderFinalResults();
      if (isHost() && state.room?.phase === "nomination" && state.members.length && state.members.every((m) => m.finished)) {
        updateDoc(roomRef(), { status: "completed", phase: "completed" }).catch(showError);
      }
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "players"), orderBy("createdAt")), (snap) => {
      state.players = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderPlayers();
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "picks"), orderBy("createdAt", "desc")), (snap) => {
      state.picks = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      render();
      renderFinalResults();
    }, showError),
    onSnapshot(doc(db, "rooms", roomId, "nominations", state.user.uid), (snap) => {
      state.myNomination = snap.exists() ? { id: snap.id, ...snap.data() } : null;
      renderPlayers();
      renderStatus();
    }, showError),
    onSnapshot(collection(db, "rooms", roomId, "lotteryChoices"), (snap) => {
      state.lotteryChoices = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
      renderLottery();
    }, showError),
  );
}

function leaveRoom() {
  cleanupListeners();
  localStorage.removeItem("draft-room-session");
  Object.assign(state, { roomId: null, room: null, members: [], players: [], picks: [], myNomination: null, lotteryChoices: [] });
  $("#reveal-screen").classList.add("hidden");
  $("#final-results").classList.add("hidden");
  $("#room").classList.add("hidden");
  $("#landing").classList.remove("hidden");
}
$("#leave-room").addEventListener("click", leaveRoom);
$("#copy-code").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.room?.code || "");
  toast("参加コードをコピーしました。");
});

function render() {
  if (!state.room) return;
  $("#room-title").textContent = state.room.name;
  $("#room-code").textContent = state.room.code;
  $("#member-count").textContent = String(state.members.length).padStart(2, "0");
  $$(".host-only").forEach((el) => el.classList.toggle("hidden", !isHost()));
  renderMembers();
  renderPlayers();
  renderStatus();
  renderHistory();
}

function renderMembers() {
  const activeId = state.room?.draftMode === "sequential" && state.room.phase === "nomination" ? currentTurnMember()?.id : null;
  $("#members-list").innerHTML = state.members.map((m, index) => {
    const submitted = hasSubmitted(m);
    return `<article class="member ${m.id === activeId ? "active" : ""} ${m.finished ? "finished" : ""}">
      <div class="member-avatar">${escapeHtml(m.name.slice(0, 1))}</div>
      <div><strong>${escapeHtml(m.name)}${m.id === state.user?.uid ? "（あなた）" : ""}</strong>
      <small>${m.finished ? "DRAFT COMPLETE" : submitted ? "PICK SUBMITTED" : m.isHost ? "COMMISSIONER" : m.id === activeId ? "ON THE CLOCK" : `PICK ${String(index + 1).padStart(2, "0")}`}</small></div>
      <span class="order">${m.finished ? "✓" : String(index + 1).padStart(2, "0")}</span></article>`;
  }).join("");
}

function renderStatus() {
  if (!state.room) return;
  const phase = state.room.phase || (state.room.status === "waiting" ? "waiting" : "nomination");
  const active = activeMembers();
  const complete = active.filter(hasSubmitted);
  const pending = active.filter((m) => !hasSubmitted(m));
  const me = currentMember();
  const simultaneous = state.room.draftMode === "simultaneous";
  $("#round-label").textContent = `ROUND ${String(state.room.round || 1).padStart(2, "0")}${currentAttempt() > 1 ? ` / 外れ${state.room.round}位 ${currentAttempt() - 1}回目` : ""}`;
  $("#start-draft").classList.toggle("hidden", !isHost() || phase !== "waiting");
  $("#next-round").classList.toggle("hidden", !isHost() || phase !== "nomination" || !simultaneous);
  $("#reset-draft").classList.toggle("hidden", !isHost() || phase === "waiting");
  $("#finish-draft").classList.toggle("hidden", !me || me.finished || !["nomination", "announcement"].includes(phase));
  $("#history-toggle").classList.toggle("hidden", phase === "waiting");
  $("#progress-details").classList.toggle("hidden", phase === "waiting" || !simultaneous);

  if (phase === "waiting") {
    $("#status-title").textContent = "参加チームを待っています";
    $("#status-subtitle").textContent = `現在 ${state.members.length} 球団参加中。候補選手を登録して開始してください。`;
  } else if (phase === "nomination" && simultaneous) {
    $("#status-title").textContent = me?.finished ? "あなたの球団は指名を終了しました" : hasSubmitted(me || {}) ? "指名を受け付けました" : currentAttempt() > 1 ? `外れ${state.room.round}位を指名してください` : "希望選手を指名してください";
    $("#status-subtitle").textContent = `${complete.length} / ${active.length} 球団完了`;
    $("#next-round").disabled = pending.length > 0 || active.length === 0;
    $("#next-round").textContent = pending.length ? "全球団の指名待ち" : "指名を締め切り、競合確認へ";
  } else if (phase === "review") {
    $("#status-title").textContent = "競合状況を集計しています";
    $("#status-subtitle").textContent = "全球団の指名が出揃いました。";
  } else if (phase === "lottery") {
    $("#status-title").textContent = "競合抽選を実施中";
    $("#status-subtitle").textContent = `${(state.room.lotteryIndex || 0) + 1} / ${(state.room.lotteryQueue || []).length} 件目の抽選`;
  } else if (phase === "announcement") {
    $("#status-title").textContent = "指名選手を発表中";
    $("#status-subtitle").textContent = "発表終了後、次の巡目へ進みます。";
  } else if (phase === "completed") {
    $("#status-title").textContent = "ドラフト会議終了";
    $("#status-subtitle").textContent = "すべての球団が指名を終了しました。";
  } else {
    const turn = currentTurnMember();
    $("#status-title").textContent = turn ? `${turn.name} の指名です` : "指名順を準備中";
    $("#status-subtitle").textContent = turn?.id === state.user?.uid ? "あなたの番です。" : "指名をお待ちください。";
  }

  $("#progress-details").innerHTML = `
    <div><b>完了</b>${complete.length ? complete.map((m) => `<span class="done">✓ ${escapeHtml(m.name)}</span>`).join("") : "<span>なし</span>"}</div>
    <div><b>未完了</b>${pending.length ? pending.map((m) => `<span>● ${escapeHtml(m.name)}</span>`).join("") : "<span class='done'>全球団完了</span>"}</div>`;
}

function renderPlayers() {
  if (!state.room) return;
  const selected = pickedIds();
  const mine = state.myNomination && state.myNomination.round === state.room.round && state.myNomination.attempt === currentAttempt() ? state.myNomination : null;
  const me = currentMember();
  const canPick = state.room.phase === "nomination" && !me?.finished && (
    state.room.draftMode === "simultaneous" ? activeMembers().some((m) => m.id === state.user?.uid) : currentTurnMember()?.id === state.user?.uid
  );
  const visible = state.players
    .filter((p) => (state.filter === "all" || p.position === state.filter || (state.filter === "staff" && ["監督", "コーチ"].includes(p.position))) && `${p.name} ${p.team || ""} ${p.role || ""}`.toLowerCase().includes(state.search.toLowerCase()))
    .sort((a, b) =>
      Number(selected.has(a.id)) - Number(selected.has(b.id))
      || (a.teamOrder ?? 999) - (b.teamOrder ?? 999)
      || (a.uniformSort ?? 9999) - (b.uniformSort ?? 9999)
      || String(b.uniformNumber || "").length - String(a.uniformNumber || "").length
      || String(a.name).localeCompare(String(b.name), "ja")
    );
  $("#empty-players").classList.toggle("hidden", state.players.length > 0);
  $("#players-list").innerHTML = visible.map((p) => {
    const picked = selected.has(p.id);
    const nominated = mine?.playerId === p.id;
    const canManage = isHost() || p.creatorId === state.user?.uid;
    return `<article class="player-card ${picked ? "picked" : ""} ${nominated ? "nominated" : ""}">
      <div class="position-badge">${escapeHtml(p.position || "—")}</div>
      <div><h4>${escapeHtml(p.name)}</h4><p>${p.uniformNumber ? `#${escapeHtml(p.uniformNumber)}　` : ""}${escapeHtml(p.team || "所属未設定")}${p.role ? `・${escapeHtml(p.role)}` : ""}</p></div>
      <div class="player-actions"><button class="pick-button" data-pick="${p.id}" ${picked || !canPick ? "disabled" : ""}>${picked ? "指名済" : nominated ? "変更" : "指名"}</button>
      ${canManage ? `<div class="manage-actions"><button class="manage-button" data-edit-player="${p.id}" ${picked ? "disabled" : ""}>編集</button><button class="manage-button danger" data-delete-player="${p.id}" ${picked ? "disabled" : ""}>削除</button></div>` : ""}</div>
    </article>`;
  }).join("");
  $$("[data-pick]").forEach((b) => b.addEventListener("click", () => nominatePlayer(b.dataset.pick)));
  $$("[data-edit-player]").forEach((b) => b.addEventListener("click", () => openPlayerEditor(b.dataset.editPlayer)));
  $$("[data-delete-player]").forEach((b) => b.addEventListener("click", () => deletePlayer(b.dataset.deletePlayer)));
}

function renderHistory() {
  if (!state.room) return;
  const revealed = new Set(state.room.revealedPickIds ?? state.picks.map((p) => p.playerId));
  const visible = state.picks.filter((p) => revealed.has(p.playerId));
  const locked = visible.length === 0;
  $("#results-panel").classList.toggle("locked", locked);
  $("#empty-results").classList.toggle("hidden", !locked);
  $("#results-message").textContent = state.room.phase === "announcement" ? "ただいま発表中です" : "発表終了後に公開されます";
  if (locked) {
    $("#history-tabs").innerHTML = "";
    $("#results-list").innerHTML = "";
    return;
  }
  if (!state.historyMemberId || !state.members.some((m) => m.id === state.historyMemberId)) state.historyMemberId = null;
  $("#history-tabs").innerHTML = state.members.map((m) => `<button data-history="${m.id}" class="${state.historyMemberId === m.id ? "active" : ""}">${escapeHtml(m.name)}</button>`).join("");
  const selected = state.historyMemberId ? visible.filter((p) => p.memberId === state.historyMemberId) : [];
  $("#results-list").innerHTML = state.historyMemberId
    ? selected.sort((a, b) => a.round - b.round).map((p) => `<article class="result ${p.viaLottery ? "lottery" : ""}"><div class="result-top"><span>ROUND ${String(p.round).padStart(2, "0")}</span><span>${p.viaLottery ? "LOTTERY" : "PICK"}</span></div><h4>${escapeHtml(p.playerName)}</h4><p>${escapeHtml(p.memberName)}</p></article>`).join("") || "<div class='empty-state compact'>指名履歴はありません</div>"
    : "<div class='empty-state compact'>球団タブを選択してください</div>";
  $$("[data-history]").forEach((b) => b.addEventListener("click", () => { state.historyMemberId = b.dataset.history; renderHistory(); }));
}

$("#history-toggle").addEventListener("click", () => $("#results-panel").classList.remove("closed"));
$("#history-close").addEventListener("click", () => $("#results-panel").classList.add("closed"));
$$(".filter").forEach((b) => b.addEventListener("click", () => {
  state.filter = b.dataset.position;
  $$(".filter").forEach((x) => x.classList.toggle("active", x === b));
  renderPlayers();
}));
$("#player-search").addEventListener("input", (e) => { state.search = e.target.value; renderPlayers(); });

$("#add-player-open").addEventListener("click", () => {
  state.editingPlayerId = null;
  $("#player-dialog-title").textContent = "候補選手を追加";
  $("#player-submit").textContent = "選手を登録する";
  $("#player-form").reset();
  $("#player-dialog").showModal();
});
function openPlayerEditor(id) {
  const p = state.players.find((x) => x.id === id);
  if (!p) return;
  state.editingPlayerId = id;
  $("#player-dialog-title").textContent = "候補選手を編集";
  $("#player-submit").textContent = "変更を保存する";
  $("#new-player-name").value = p.name;
  $("#new-player-position").value = p.position || "投手";
  $("#new-player-team").value = p.team || "";
  $("#player-dialog").showModal();
}
async function deletePlayer(id) {
  const p = state.players.find((x) => x.id === id);
  if (!p || !confirm(`「${p.name}」を削除しますか？`)) return;
  try { await deleteDoc(doc(db, "rooms", state.roomId, "players", id)); toast("候補選手を削除しました。"); }
  catch (error) { showError(error); }
}
$("#player-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = $("#new-player-name").value.trim();
  if (!name) return;
  if (state.players.some((p) => p.id !== state.editingPlayerId && normalizeName(p.name) === normalizeName(name))) return toast("同名の選手が登録済みです。");
  const values = { name, normalizedName: normalizeName(name), position: $("#new-player-position").value, team: $("#new-player-team").value.trim() };
  if (state.editingPlayerId) await updateDoc(doc(db, "rooms", state.roomId, "players", state.editingPlayerId), { ...values, updatedAt: serverTimestamp() });
  else await addDoc(collection(db, "rooms", state.roomId, "players"), { ...values, creatorId: state.user.uid, createdAt: serverTimestamp() });
  const edited = Boolean(state.editingPlayerId);
  state.editingPlayerId = null;
  event.target.reset();
  $("#player-dialog").close();
  toast(edited ? "選手情報を更新しました。" : "候補選手を追加しました。");
});
$("#player-dialog").addEventListener("close", () => { state.editingPlayerId = null; $("#player-form").reset(); });

$("#start-draft").addEventListener("click", async () => {
  if (!state.members.length || !state.players.length) return toast("参加球団と候補選手を確認してください。");
  const button = $("#start-draft");
  button.disabled = true;
  try {
    const batch = writeBatch(db);
    state.members.forEach((m) => batch.update(doc(db, "rooms", state.roomId, "members", m.id), { finished: false, hasSubmitted: false }));
    batch.update(roomRef(), {
      status: "drafting", phase: "nomination", round: 1, attempt: 1, turnIndex: 0,
      draftOrder: state.members.map((m) => m.id), eligibleMemberIds: state.members.map((m) => m.id),
      announcement: null, revealedPickIds: [], lottery: null, lotteryQueue: [], lotteryLosers: [],
    });
    await batch.commit();
  } catch (error) {
    showError(error);
  } finally {
    button.disabled = false;
  }
});

async function nominatePlayer(playerId) {
  const player = state.players.find((p) => p.id === playerId);
  const member = currentMember();
  if (!player || !member) return;
  if (state.room.draftMode === "sequential") return nominateSequential(player, member);
  try {
    await setDoc(doc(db, "rooms", state.roomId, "nominations", state.user.uid), {
      round: state.room.round, attempt: currentAttempt(), memberId: state.user.uid, memberName: member.name,
      playerId: player.id, playerName: player.name, normalizedName: player.normalizedName || normalizeName(player.name),
      createdAt: serverTimestamp(),
    });
    await updateDoc(doc(db, "rooms", state.roomId, "members", state.user.uid), {
      hasSubmitted: true, nominationRound: state.room.round, nominationAttempt: currentAttempt(),
    });
    toast(`${player.name}を指名しました。締切までは変更できます。`);
  } catch (error) { showError(error); }
}

async function nominateSequential(player, member) {
  try {
    await runTransaction(db, async (tx) => {
      const fresh = await tx.get(roomRef());
      const data = fresh.data();
      if (currentTurnMember()?.id !== state.user.uid) throw new Error("現在はあなたの指名順ではありません。");
      const pickRef = doc(db, "rooms", state.roomId, "picks", player.id);
      if ((await tx.get(pickRef)).exists()) throw new Error("この選手は指名済みです。");
      const activeCount = Math.max(1, state.members.filter((m) => !m.finished).length);
      const pickRound = Math.floor((data.turnIndex || 0) / activeCount) + 1;
      const nextTurn = (data.turnIndex || 0) + 1;
      const nextRound = Math.floor(nextTurn / activeCount) + 1;
      tx.set(pickRef, { round: pickRound, memberId: member.id, memberName: member.name, playerId: player.id, playerName: player.name, createdAt: serverTimestamp() });
      tx.update(roomRef(), { turnIndex: nextTurn, round: nextRound, announcement: makeAnnouncement([makeRevealItem(member, player, pickRound)], pickRound), phase: "announcement" });
    });
  } catch (error) { showError(error); }
}

$("#finish-draft").addEventListener("click", async () => {
  if (!confirm("この球団の指名を終了しますか？終了後は再参加できません。")) return;
  const batch = writeBatch(db);
  batch.update(doc(db, "rooms", state.roomId, "members", state.user.uid), { finished: true, hasSubmitted: false, finishedAt: serverTimestamp() });
  batch.delete(doc(db, "rooms", state.roomId, "nominations", state.user.uid));
  await batch.commit();
  toast("指名を終了しました。");
});

$("#next-round").addEventListener("click", resolveNominations);
async function resolveNominations() {
  const active = activeMembers();
  if (!active.length || active.some((m) => !hasSubmitted(m))) return toast("まだ指名していない球団があります。");
  try {
    await updateDoc(roomRef(), { phase: "review" });
    const snap = await getDocs(collection(db, "rooms", state.roomId, "nominations"));
    const nominations = snap.docs.map((d) => ({ id: d.id, ...d.data() })).filter((n) => n.round === state.room.round && n.attempt === currentAttempt() && active.some((m) => m.id === n.memberId));
    const groups = Object.values(nominations.reduce((acc, n) => { (acc[n.normalizedName] ||= []).push(n); return acc; }, {}));
    const uncontested = groups.filter((g) => g.length === 1).flat();
    const conflicts = groups.filter((g) => g.length > 1).map((g, i) => ({
      id: `${Date.now()}_${i}`, playerId: g[0].playerId, playerName: g[0].playerName,
      entrants: g.map((n) => ({ memberId: n.memberId, memberName: n.memberName })),
    }));
    const memberOrder = new Map(state.members.map((m, i) => [m.id, i]));
    const revealItems = [...nominations]
      .sort((a, b) => (memberOrder.get(a.memberId) ?? 999) - (memberOrder.get(b.memberId) ?? 999))
      .map((n) => {
        const player = state.players.find((p) => p.id === n.playerId) || n;
        const member = state.members.find((m) => m.id === n.memberId) || n;
        return makeRevealItem(member, player, state.room.round, false);
      });
    await securePicks(uncontested, false);
    await updateDoc(roomRef(), {
      phase: "announcement",
      lotteryQueue: conflicts,
      lotteryIndex: 0,
      lotteryLosers: [],
      lottery: null,
      announcement: {
        ...makeAnnouncement(revealItems, state.room.round),
        afterPhase: conflicts.length ? "lottery" : "next-round",
      },
    });
  } catch (error) { showError(error); }
}

async function securePicks(items, viaLottery) {
  if (!items.length) return;
  const batch = writeBatch(db);
  items.forEach((n) => {
    batch.set(doc(db, "rooms", state.roomId, "picks", n.playerId), {
      round: state.room.round, attempt: currentAttempt(), memberId: n.memberId, memberName: n.memberName,
      playerId: n.playerId, playerName: n.playerName, viaLottery, createdAt: serverTimestamp(),
    });
    batch.delete(doc(db, "rooms", state.roomId, "nominations", n.memberId));
  });
  await batch.commit();
}

function makeLottery(group, index, total) {
  return { id: `${group.id}_${Date.now()}`, status: "overview", playerId: group.playerId, playerName: group.playerName, entrants: group.entrants, index, total };
}

function renderLottery() {
  const lottery = state.room?.lottery;
  const dialog = $("#lottery-dialog");
  if (state.room?.phase !== "lottery" || !lottery) {
    if (dialog.open) dialog.close();
    return;
  }
  if (!dialog.open) dialog.showModal();
  const choices = state.lotteryChoices.filter((c) => c.lotteryId === lottery.id);
  const mine = choices.find((c) => c.memberId === state.user?.uid);
  const entrant = lottery.entrants.some((e) => e.memberId === state.user?.uid);
  $("#lottery-step").textContent = `${String((lottery.index || 0) + 1).padStart(2, "0")} / ${String(lottery.total || 1).padStart(2, "0")}`;
  $("#lottery-player").textContent = lottery.playerName;
  $("#lottery-teams").textContent = lottery.entrants.map((e) => e.memberName).join(" × ");
  $("#conflict-list").innerHTML = lottery.status === "overview"
    ? state.room.lotteryQueue.map((group, i) => `<span class="${i < lottery.index ? "ready" : ""}">${i + 1}. ${escapeHtml(group.playerName)}（${group.entrants.length}球団）</span>`).join("")
    : lottery.entrants.map((e) => {
      const choice = choices.find((c) => c.memberId === e.memberId);
      return `<span class="${choice ? "ready" : ""}">${choice ? "✓" : "●"} ${escapeHtml(e.memberName)}</span>`;
    }).join("");
  $("#envelope-grid").classList.toggle("hidden", lottery.status === "overview");
  $("#envelope-grid").innerHTML = lottery.entrants.map((_, i) => {
    const selected = mine?.envelope === i;
    const opened = lottery.status === "revealed";
    const winnerChoice = choices.find((c) => c.memberId === lottery.winner?.memberId);
    const winnerEnvelope = winnerChoice?.envelope;
    return `<button class="envelope ${selected ? "selected" : ""} ${opened ? "opened" : ""} ${opened && i === winnerEnvelope ? "winner" : ""}" data-envelope="${i}" ${!entrant || lottery.status !== "choosing" ? "disabled" : ""}>
      <i></i><b>${opened && i === winnerEnvelope ? "交渉権確定" : `封筒 ${i + 1}`}</b></button>`;
  }).join("");
  $$("[data-envelope]").forEach((b) => b.addEventListener("click", () => selectEnvelope(Number(b.dataset.envelope))));
  const allChosen = lottery.entrants.every((e) => choices.some((c) => c.memberId === e.memberId));
  $("#lottery-guide").textContent = lottery.status === "overview" ? `競合 ${state.room.lotteryQueue.length}件を順番に抽選します` : lottery.status === "revealed" ? "抽選結果が確定しました" : mine ? `封筒 ${mine.envelope + 1} を選択済み` : entrant ? "封筒を1つ選択してください" : `${choices.length} / ${lottery.entrants.length} 球団が選択済み`;
  $("#run-lottery").classList.toggle("hidden", !isHost() || !["overview", "choosing"].includes(lottery.status));
  $("#run-lottery").textContent = lottery.status === "overview" ? "競合一覧を確認して抽選へ" : "封筒を一斉開封";
  $("#run-lottery").disabled = lottery.status === "choosing" && !allChosen;
  $("#close-lottery").classList.toggle("hidden", !isHost() || lottery.status !== "revealed");
  $("#lottery-result").classList.toggle("hidden", lottery.status !== "revealed");
  if (lottery.status === "revealed") {
    $("#lottery-winner").textContent = lottery.winner.memberName;
    $("#lottery-winning-player").textContent = `${lottery.playerName} 交渉権獲得`;
  }
}

async function selectEnvelope(envelope) {
  const lottery = state.room.lottery;
  if (!lottery?.entrants.some((e) => e.memberId === state.user.uid)) return;
  await setDoc(doc(db, "rooms", state.roomId, "lotteryChoices", `${lottery.id}_${state.user.uid}`), {
    lotteryId: lottery.id, memberId: state.user.uid, memberName: currentMember().name, envelope, selectedAt: serverTimestamp(),
  });
}

$("#run-lottery").addEventListener("click", async () => {
  const lottery = state.room.lottery;
  if (lottery.status === "overview") {
    await updateDoc(roomRef(), { lottery: { ...lottery, status: "choosing" } });
    return;
  }
  const entrants = lottery.entrants;
  const winner = entrants[Math.floor(Math.random() * entrants.length)];
  await updateDoc(roomRef(), { lottery: { ...lottery, status: "revealed", winner, revealedAt: Date.now() } });
});

$("#close-lottery").addEventListener("click", async () => {
  const lottery = state.room.lottery;
  const winner = lottery.winner;
  const losers = lottery.entrants.filter((e) => e.memberId !== winner.memberId);
  await securePicks([{ ...winner, playerId: lottery.playerId, playerName: lottery.playerName }], true);
  const allLosers = [...(state.room.lotteryLosers || []), ...losers.map((e) => e.memberId)];
  const nextIndex = (state.room.lotteryIndex || 0) + 1;
  if (nextIndex < state.room.lotteryQueue.length) {
    await updateDoc(roomRef(), { lotteryIndex: nextIndex, lotteryLosers: allLosers, lottery: makeLottery(state.room.lotteryQueue[nextIndex], nextIndex, state.room.lotteryQueue.length) });
  } else {
    for (const group of state.room.lotteryQueue) {
      for (const entrant of group.entrants) await deleteDoc(doc(db, "rooms", state.roomId, "nominations", entrant.memberId)).catch(() => {});
    }
    await finishNominationCycle([...new Set(allLosers)]);
  }
});

async function finishNominationCycle(losers) {
  if (losers.length) {
    const batch = writeBatch(db);
    losers.forEach((id) => batch.update(doc(db, "rooms", state.roomId, "members", id), { hasSubmitted: false }));
    batch.update(roomRef(), {
      phase: "nomination", attempt: currentAttempt() + 1, eligibleMemberIds: losers,
      lottery: null, lotteryQueue: [], lotteryIndex: 0, lotteryLosers: [],
    });
    await batch.commit();
    toast(`外れ${state.room.round}位指名へ進みます。`);
    return;
  }
  await advanceToNextRound();
}

async function advanceToNextRound() {
  const unfinished = state.members.filter((m) => !m.finished);
  const batch = writeBatch(db);
  state.members.forEach((m) => batch.update(doc(db, "rooms", state.roomId, "members", m.id), { hasSubmitted: false }));
  batch.update(roomRef(), {
    phase: unfinished.length ? "nomination" : "completed",
    status: unfinished.length ? "drafting" : "completed",
    round: state.room.round + 1,
    attempt: 1,
    eligibleMemberIds: unfinished.map((m) => m.id),
    lottery: null,
    lotteryQueue: [],
    lotteryIndex: 0,
    lotteryLosers: [],
  });
  await batch.commit();
}

function makeRevealItem(member, player, round, viaLottery = false) {
  return { memberId: member.id || member.memberId, memberName: member.name || member.memberName, playerId: player.id || player.playerId, playerName: player.name || player.playerName, position: player.position || "", team: player.team || "", round, viaLottery };
}
function makeAnnouncement(items, round) {
  return { id: `${Date.now()}_${Math.random().toString(36).slice(2, 7)}`, status: "active", index: 0, round, items, changedAt: Date.now() };
}

function renderAnnouncement() {
  const a = state.room?.announcement;
  clearTimeout(state.announcementTimer);
  clearTimeout(state.revealDelayTimer);
  if (state.room?.phase !== "announcement" || !a?.items?.length || a.status !== "active") {
    $("#reveal-screen").classList.add("hidden");
    state.renderedAnnouncement = "";
    return;
  }
  const index = Math.min(a.index || 0, a.items.length - 1);
  const item = a.items[index];
  const key = `${a.id}_${index}`;
  $("#reveal-screen").classList.remove("hidden");
  $("#reveal-curtain").classList.remove("is-revealed");
  $("#reveal-round").textContent = `${state.room.name} — ROUND ${String(a.round).padStart(2, "0")}`;
  $("#reveal-order").textContent = `第${a.round}巡選択希望選手`;
  $("#reveal-prelude-text").textContent = `第${a.round}巡選択希望選手`;
  $("#reveal-team").textContent = item.memberName;
  $("#reveal-seal").textContent = item.memberName.slice(0, 1);
  $("#reveal-player").textContent = item.playerName;
  $("#reveal-meta").textContent = [item.team, item.position, item.viaLottery ? "抽選交渉権獲得" : ""].filter(Boolean).join(" / ") || "PROFILE UNAVAILABLE";
  $("#reveal-count").textContent = `${String(index + 1).padStart(2, "0")} / ${String(a.items.length).padStart(2, "0")}`;
  $("#skip-reveal").classList.toggle("hidden", !isHost());
  if (state.renderedAnnouncement !== key) {
    state.renderedAnnouncement = key;
    const curtain = $("#reveal-curtain");
    const bar = $("#reveal-progress-bar");
    curtain.style.animation = "none";
    bar.classList.remove("running");
    void curtain.offsetWidth;
    curtain.style.animation = "";
    state.revealDelayTimer = setTimeout(() => { curtain.classList.add("is-revealed"); bar.classList.add("running"); }, 1500);
  }
  if (isHost()) state.announcementTimer = setTimeout(() => advanceAnnouncement(a.id, index), 7000);
}

async function advanceAnnouncement(id = state.room?.announcement?.id, index = state.room?.announcement?.index || 0) {
  const a = state.room?.announcement;
  if (!isHost() || !a || a.id !== id || a.index !== index) return;
  const done = index + 1 >= a.items.length;
  if (!done) return updateDoc(roomRef(), { announcement: { ...a, index: index + 1, changedAt: Date.now() } });
  const revealedPickIds = [...new Set([...(state.room.revealedPickIds || []), ...a.items.map((x) => x.playerId)])];
  const unfinished = state.members.filter((m) => !m.finished);
  if (!unfinished.length) {
    await updateDoc(roomRef(), { announcement: { ...a, status: "done" }, revealedPickIds, phase: "completed", status: "completed" });
  } else if (state.room.draftMode === "sequential") {
    await updateDoc(roomRef(), { announcement: { ...a, status: "done" }, revealedPickIds, phase: "nomination" });
  } else if (a.afterPhase === "lottery" && state.room.lotteryQueue?.length) {
    const current = makeLottery(state.room.lotteryQueue[0], 0, state.room.lotteryQueue.length);
    await updateDoc(roomRef(), {
      announcement: { ...a, status: "done" },
      revealedPickIds,
      phase: "lottery",
      lotteryIndex: 0,
      lotteryLosers: [],
      lottery: current,
    });
  } else {
    await updateDoc(roomRef(), { announcement: { ...a, status: "done" }, revealedPickIds });
    await advanceToNextRound();
  }
}
$("#skip-reveal").addEventListener("click", () => advanceAnnouncement());

function renderFinalResults() {
  const completed = state.room?.phase === "completed";
  $("#final-results").classList.toggle("hidden", !completed);
  $("#room").classList.toggle("hidden", completed);
  if (!completed) return;
  const maxRound = Math.max(0, ...state.picks.map((p) => p.round || 0));
  $("#result-room-name").textContent = state.room.name;
  $("#result-team-count").textContent = state.members.length;
  $("#result-pick-count").textContent = state.picks.length;
  $("#result-round-count").textContent = maxRound;
  const cells = [`<div class="result-cell corner">巡目 / 球団</div>`, ...state.members.map((m) => `<div class="result-cell team-head">${escapeHtml(m.name)}</div>`)];
  for (let round = 1; round <= maxRound; round++) {
    cells.push(`<div class="result-cell round-head">${round}巡目</div>`);
    state.members.forEach((m) => {
      const pick = state.picks.find((p) => p.round === round && p.memberId === m.id);
      cells.push(`<div class="result-cell">${pick ? `<b>${escapeHtml(pick.playerName)}</b><span>${pick.viaLottery ? "抽選" : "指名"}</span>` : "—"}</div>`);
    });
  }
  $("#result-board").style.setProperty("--teams", state.members.length);
  $("#result-board").innerHTML = cells.join("");
  $("#team-results").innerHTML = state.members.map((m, i) => {
    const picks = state.picks.filter((p) => p.memberId === m.id).sort((a, b) => a.round - b.round);
    return `<article><header><span>${String(i + 1).padStart(2, "0")}</span><h3>${escapeHtml(m.name)}</h3><b>${picks.length}名</b></header>${picks.map((p) => `<p><i>${p.round}巡目</i><strong>${escapeHtml(p.playerName)}</strong></p>`).join("") || "<p>指名なし</p>"}</article>`;
  }).join("");
}
$("#result-back").addEventListener("click", () => { $("#final-results").classList.add("hidden"); $("#room").classList.remove("hidden"); });

$("#reset-draft").addEventListener("click", async () => {
  if (!confirm("すべての指名結果を削除して待機状態へ戻しますか？")) return;
  const batch = writeBatch(db);
  for (const name of ["picks", "nominations", "lotteryChoices"]) {
    const snap = await getDocs(collection(db, "rooms", state.roomId, name));
    snap.forEach((d) => batch.delete(d.ref));
  }
  state.members.forEach((m) => batch.update(doc(db, "rooms", state.roomId, "members", m.id), { finished: false, hasSubmitted: false }));
  batch.update(roomRef(), {
    status: "waiting", phase: "waiting", round: 1, attempt: 1, turnIndex: 0, draftOrder: [],
    eligibleMemberIds: [], lottery: null, lotteryQueue: [], lotteryIndex: 0, lotteryLosers: [],
    announcement: null, revealedPickIds: [],
  });
  await batch.commit();
});
