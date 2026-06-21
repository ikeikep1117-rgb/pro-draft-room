import { initializeApp } from "https://www.gstatic.com/firebasejs/11.9.1/firebase-app.js";
import {
  getAuth,
  signInAnonymously,
  onAuthStateChanged,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-auth.js";
import {
  getFirestore,
  collection,
  doc,
  addDoc,
  setDoc,
  getDoc,
  getDocs,
  updateDoc,
  deleteDoc,
  onSnapshot,
  query,
  orderBy,
  serverTimestamp,
  runTransaction,
  writeBatch,
} from "https://www.gstatic.com/firebasejs/11.9.1/firebase-firestore.js";
import { firebaseConfig } from "./firebase-config.js";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const state = {
  user: null,
  roomId: null,
  room: null,
  members: [],
  players: [],
  picks: [],
  nominations: [],
  manualConflict: new Set(),
  filter: "all",
  search: "",
  unsubs: [],
};

const configured = !Object.values(firebaseConfig).some((value) => String(value).includes("YOUR_"));
let db;
let auth;

if (configured) {
  const app = initializeApp(firebaseConfig);
  db = getFirestore(app);
  auth = getAuth(app);
  signInAnonymously(auth).catch(showError);
  onAuthStateChanged(auth, (user) => {
    state.user = user;
    restoreSession();
  });
} else {
  $("#setup-note").textContent =
    "Firebaseの設定が未入力です。firebase-config.js を編集すると部屋を作成できます。";
}

function toast(message) {
  const el = $("#toast");
  el.textContent = message;
  el.classList.add("show");
  clearTimeout(toast.timer);
  toast.timer = setTimeout(() => el.classList.remove("show"), 2600);
}

function showError(error) {
  console.error(error);
  const messages = {
    "auth/operation-not-allowed": "Firebaseで匿名認証を有効にしてください。",
    "permission-denied": "Firestoreのルールまたは権限を確認してください。",
  };
  toast(messages[error?.code] || error?.message || "処理に失敗しました");
}

function makeCode() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: 6 }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

function normalizeName(value) {
  return value.normalize("NFKC").toLowerCase().replace(/[\s・.．]/g, "");
}

function roomRef() {
  return doc(db, "rooms", state.roomId);
}

function isHost() {
  return state.room?.hostId === state.user?.uid;
}

function currentMember() {
  return state.members.find((member) => member.id === state.user?.uid);
}

function currentTurnMember() {
  if (!state.room?.draftOrder?.length) return null;
  const id = state.room.draftOrder[state.room.turnIndex % state.room.draftOrder.length];
  return state.members.find((member) => member.id === id);
}

function cleanupListeners() {
  state.unsubs.forEach((unsub) => unsub());
  state.unsubs = [];
}

async function restoreSession() {
  const saved = JSON.parse(localStorage.getItem("draft-room-session") || "null");
  if (!saved || !state.user || saved.userId !== state.user.uid) return;
  const snapshot = await getDoc(doc(db, "rooms", saved.roomId));
  if (snapshot.exists()) enterRoom(saved.roomId);
  else localStorage.removeItem("draft-room-session");
}

$$(".tab").forEach((button) => {
  button.addEventListener("click", () => {
    $$(".tab").forEach((tab) => tab.classList.toggle("active", tab === button));
    $$(".entry-form").forEach((form) => form.classList.toggle("active", form.id.startsWith(button.dataset.tab)));
  });
});

$("#join-code").addEventListener("input", (event) => {
  event.target.value = event.target.value.toUpperCase().replace(/[^A-Z0-9]/g, "");
});

$("#draft-mode").addEventListener("change", (event) => {
  $("#conflict-mode").disabled = event.target.value === "sequential";
});

$("#create-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured || !state.user) return toast("Firebaseへの接続を確認してください");
  const submit = event.submitter;
  submit.disabled = true;
  try {
    let code;
    let duplicate;
    do {
      code = makeCode();
      duplicate = await getDocs(query(collection(db, "rooms")));
    } while (duplicate.docs.some((item) => item.data().code === code));

    const room = await addDoc(collection(db, "rooms"), {
      code,
      name: $("#room-name").value.trim(),
      hostId: state.user.uid,
      status: "waiting",
      draftMode: $("#draft-mode").value,
      conflictMode: $("#conflict-mode").value,
      round: 1,
      turnIndex: 0,
      draftOrder: [],
      createdAt: serverTimestamp(),
    });
    await setDoc(doc(db, "rooms", room.id, "members", state.user.uid), {
      name: $("#create-name").value.trim(),
      joinedAt: serverTimestamp(),
      order: 0,
      isHost: true,
    });
    enterRoom(room.id);
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
});

$("#join-form").addEventListener("submit", async (event) => {
  event.preventDefault();
  if (!configured || !state.user) return toast("Firebaseへの接続を確認してください");
  const submit = event.submitter;
  submit.disabled = true;
  try {
    const code = $("#join-code").value.trim().toUpperCase();
    const rooms = await getDocs(collection(db, "rooms"));
    const found = rooms.docs.find((item) => item.data().code === code);
    if (!found) return toast("参加コードが見つかりません");
    const memberSnapshot = await getDocs(collection(db, "rooms", found.id, "members"));
    await setDoc(doc(db, "rooms", found.id, "members", state.user.uid), {
      name: $("#join-name").value.trim(),
      joinedAt: serverTimestamp(),
      order: memberSnapshot.size,
      isHost: false,
    });
    enterRoom(found.id);
  } catch (error) {
    showError(error);
  } finally {
    submit.disabled = false;
  }
});

function enterRoom(roomId) {
  cleanupListeners();
  state.roomId = roomId;
  localStorage.setItem("draft-room-session", JSON.stringify({ roomId, userId: state.user.uid }));
  $("#landing").classList.add("hidden");
  $("#room").classList.remove("hidden");

  state.unsubs.push(
    onSnapshot(roomRef(), (snapshot) => {
      if (!snapshot.exists()) return leaveRoom();
      const previousLottery = state.room?.lottery;
      state.room = { id: snapshot.id, ...snapshot.data() };
      render();
      if (state.room.lottery?.status === "ready" && previousLottery?.id !== state.room.lottery.id) {
        openLottery();
      }
      if (state.room.lottery?.status === "done" && previousLottery?.status !== "done") showLotteryResult();
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "members"), orderBy("order")), (snapshot) => {
      state.members = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "players"), orderBy("createdAt")), (snapshot) => {
      state.players = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      renderPlayers();
    }, showError),
    onSnapshot(query(collection(db, "rooms", roomId, "picks"), orderBy("createdAt", "desc")), (snapshot) => {
      state.picks = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    }, showError),
    onSnapshot(collection(db, "rooms", roomId, "nominations"), (snapshot) => {
      state.nominations = snapshot.docs.map((item) => ({ id: item.id, ...item.data() }));
      render();
    }, showError),
  );
}

function leaveRoom() {
  cleanupListeners();
  localStorage.removeItem("draft-room-session");
  Object.assign(state, { roomId: null, room: null, members: [], players: [], picks: [], nominations: [] });
  $("#room").classList.add("hidden");
  $("#landing").classList.remove("hidden");
}

$("#leave-room").addEventListener("click", leaveRoom);
$("#copy-code").addEventListener("click", async () => {
  await navigator.clipboard.writeText(state.room?.code || "");
  toast("参加コードをコピーしました");
});

function render() {
  if (!state.room) return;
  $("#room-title").textContent = state.room.name;
  $("#room-code").textContent = state.room.code;
  $("#member-count").textContent = String(state.members.length).padStart(2, "0");
  $$(".host-only").forEach((item) => item.classList.toggle("hidden", !isHost()));
  renderMembers();
  renderPlayers();
  renderResults();
  renderStatus();
}

function renderMembers() {
  const activeId = state.room?.draftMode === "sequential" && state.room.status === "drafting"
    ? currentTurnMember()?.id
    : null;
  $("#members-list").innerHTML = state.members.map((member, index) => `
    <article class="member ${member.id === activeId ? "active" : ""}">
      <div class="member-avatar">${escapeHtml(member.name.slice(0, 1))}</div>
      <div>
        <strong>${escapeHtml(member.name)}${member.id === state.user?.uid ? "（あなた）" : ""}</strong>
        <small>${member.isHost ? "COMMISSIONER" : activeId === member.id ? "ON THE CLOCK" : "TEAM"}</small>
      </div>
      <span class="order">${String(index + 1).padStart(2, "0")}</span>
    </article>
  `).join("");
}

function renderStatus() {
  const waiting = state.room.status === "waiting";
  const finished = state.room.status === "finished";
  $("#start-draft").classList.toggle("hidden", !isHost() || !waiting);
  $("#reset-draft").classList.toggle("hidden", !isHost() || waiting);
  $("#next-round").classList.add("hidden");
  $("#round-label").textContent = waiting ? "WAITING ROOM" : `ROUND ${String(state.room.round).padStart(2, "0")}`;

  if (waiting) {
    $("#status-title").textContent = "参加者を待っています";
    $("#status-subtitle").textContent = `${state.members.length}球団が参加中。主催者が指名順を確定して開始します。`;
  } else if (finished) {
    $("#status-title").textContent = "ドラフト会議は終了しました";
    $("#status-subtitle").textContent = "すべての指名結果が確定しています。";
  } else if (state.room.draftMode === "sequential") {
    const member = currentTurnMember();
    $("#status-title").textContent = member ? `${member.name}、選択希望選手は…` : "指名順を確認中";
    $("#status-subtitle").textContent = member?.id === state.user?.uid ? "あなたの指名番です。選手一覧から指名してください。" : "指名結果は全員の画面へ即時反映されます。";
  } else {
    const mine = state.nominations.find((item) => item.memberId === state.user?.uid && item.round === state.room.round);
    const allDone = state.members.length > 0 && state.nominations.filter((item) => item.round === state.room.round).length >= state.members.length;
    $("#status-title").textContent = mine ? "指名を受け付けました" : "第" + state.room.round + "巡選択希望選手";
    $("#status-subtitle").textContent = mine ? `${mine.playerName}を指名中。全員の入力を待っています。` : "全参加者が同時に選手を指名します。";
    $("#next-round").classList.toggle("hidden", !isHost() || !allDone);
    $("#next-round").textContent = state.room.conflictMode === "host-review" ? "重複を目視確認して確定" : "指名を締切・抽選";
  }
}

function renderPlayers() {
  if (!state.room) return;
  const pickedIds = new Set(state.picks.map((pick) => pick.playerId));
  const myNomination = state.nominations.find((item) => item.memberId === state.user?.uid && item.round === state.room.round);
  const visible = state.players.filter((player) => {
    const matchesPosition = state.filter === "all" || player.position === state.filter;
    const text = `${player.name} ${player.team || ""}`.toLowerCase();
    return matchesPosition && text.includes(state.search.toLowerCase());
  });
  $("#empty-players").classList.toggle("hidden", state.players.length > 0);
  $("#players-list").innerHTML = visible.map((player) => {
    const picked = pickedIds.has(player.id);
    const nominated = myNomination?.playerId === player.id;
    let disabled = picked || state.room.status !== "drafting";
    if (state.room.draftMode === "sequential") disabled ||= currentTurnMember()?.id !== state.user?.uid;
    else disabled ||= Boolean(myNomination);
    return `
      <article class="player-card ${picked ? "picked" : ""} ${nominated ? "nominated" : ""}">
        <div class="position-badge">${escapeHtml(player.position?.slice(0, 2) || "選手")}</div>
        <div><h4>${escapeHtml(player.name)}</h4><p>${escapeHtml(player.team || "所属未登録")}</p></div>
        <button class="pick-button" data-pick="${player.id}" ${disabled ? "disabled" : ""}>
          ${picked ? "指名済" : nominated ? "指名中" : "指名する"}
        </button>
      </article>`;
  }).join("");
  $$("[data-pick]").forEach((button) => button.addEventListener("click", () => nominatePlayer(button.dataset.pick)));
}

function renderResults() {
  const currentNominations = state.room?.draftMode === "simultaneous" && state.room?.status === "drafting"
    ? state.nominations.filter((item) => item.round === state.room.round)
    : [];
  $("#empty-results").classList.toggle("hidden", state.picks.length > 0 || currentNominations.length > 0);
  const reviewCards = currentNominations.map((nomination) => `
    <article class="result nomination">
      <div class="result-top"><span>ROUND ${String(nomination.round).padStart(2, "0")}</span><span>NOMINATION</span></div>
      <h4>${escapeHtml(nomination.playerName)}</h4>
      <p>${escapeHtml(nomination.memberName)}</p>
      ${isHost() && state.room.conflictMode === "host-review" ? `
        <label class="conflict-check">
          <input type="checkbox" data-conflict="${nomination.id}" ${state.manualConflict.has(nomination.id) ? "checked" : ""}>
          同一選手として抽選
        </label>` : ""}
    </article>
  `).join("");
  const pickCards = state.picks.map((pick) => `
    <article class="result ${pick.viaLottery ? "lottery" : ""}">
      <div class="result-top"><span>ROUND ${String(pick.round).padStart(2, "0")}</span><span>${pick.viaLottery ? "LOTTERY" : "PICK"}</span></div>
      <h4>${escapeHtml(pick.playerName)}</h4>
      <p>${escapeHtml(pick.memberName)}</p>
    </article>
  `).join("");
  $("#results-list").innerHTML = reviewCards + pickCards;
  $$("[data-conflict]").forEach((checkbox) => checkbox.addEventListener("change", () => {
    if (checkbox.checked) state.manualConflict.add(checkbox.dataset.conflict);
    else state.manualConflict.delete(checkbox.dataset.conflict);
  }));
}

$$(".filter").forEach((button) => button.addEventListener("click", () => {
  state.filter = button.dataset.position;
  $$(".filter").forEach((item) => item.classList.toggle("active", item === button));
  renderPlayers();
}));
$("#player-search").addEventListener("input", (event) => {
  state.search = event.target.value;
  renderPlayers();
});

$("#add-player-open").addEventListener("click", () => $("#player-dialog").showModal());
$("#player-form").addEventListener("submit", async (event) => {
  if (event.submitter?.value === "cancel") return;
  event.preventDefault();
  const name = $("#new-player-name").value.trim();
  if (!name) return;
  const duplicate = state.players.some((player) => normalizeName(player.name) === normalizeName(name));
  if (duplicate) return toast("同名の選手がすでに登録されています");
  await addDoc(collection(db, "rooms", state.roomId, "players"), {
    name,
    normalizedName: normalizeName(name),
    position: $("#new-player-position").value,
    team: $("#new-player-team").value.trim(),
    createdAt: serverTimestamp(),
  });
  event.target.reset();
  $("#player-dialog").close();
  toast("候補選手を追加しました");
});

$("#start-draft").addEventListener("click", async () => {
  if (state.members.length < 1) return toast("参加者がいません");
  if (state.players.length < 1) return toast("候補選手を1人以上追加してください");
  await updateDoc(roomRef(), {
    status: "drafting",
    round: 1,
    turnIndex: 0,
    draftOrder: state.members.map((member) => member.id),
  });
});

async function nominatePlayer(playerId) {
  const player = state.players.find((item) => item.id === playerId);
  const member = currentMember();
  if (!player || !member) return;
  if (state.room.draftMode === "simultaneous") {
    await setDoc(doc(db, "rooms", state.roomId, "nominations", `${state.room.round}_${state.user.uid}`), {
      round: state.room.round,
      memberId: state.user.uid,
      memberName: member.name,
      playerId: player.id,
      playerName: player.name,
      normalizedName: player.normalizedName || normalizeName(player.name),
      createdAt: serverTimestamp(),
    });
    return toast(`${player.name}を指名しました`);
  }

  try {
    await runTransaction(db, async (transaction) => {
      const freshRoom = await transaction.get(roomRef());
      const data = freshRoom.data();
      const activeId = data.draftOrder[data.turnIndex % data.draftOrder.length];
      if (activeId !== state.user.uid) throw new Error("現在はあなたの指名番ではありません");
      const pickRef = doc(db, "rooms", state.roomId, "picks", player.id);
      const existingPick = await transaction.get(pickRef);
      if (existingPick.exists()) throw new Error("この選手はすでに指名済みです");
      transaction.set(pickRef, {
        round: Math.floor(data.turnIndex / data.draftOrder.length) + 1,
        memberId: member.id,
        memberName: member.name,
        playerId: player.id,
        playerName: player.name,
        viaLottery: false,
        createdAt: serverTimestamp(),
      });
      transaction.update(roomRef(), {
        turnIndex: data.turnIndex + 1,
        round: Math.floor((data.turnIndex + 1) / data.draftOrder.length) + 1,
      });
    });
    toast(`${player.name}の交渉権を獲得しました`);
  } catch (error) {
    showError(error);
  }
}

$("#next-round").addEventListener("click", resolveSimultaneousRound);

async function resolveSimultaneousRound() {
  const nominations = state.nominations.filter((item) => item.round === state.room.round);
  if (nominations.length < state.members.length) return toast("まだ指名していない参加者がいます");
  const groups = Object.values(nominations.reduce((acc, nomination) => {
    const key = nomination.normalizedName;
    (acc[key] ||= []).push(nomination);
    return acc;
  }, {}));
  const manuallySelected = nominations.filter((item) => state.manualConflict.has(item.id));
  if (state.room.conflictMode === "host-review" && state.manualConflict.size === 1) {
    return toast("競合として扱う指名を2つ以上選んでください");
  }
  const conflict = manuallySelected.length > 1 ? manuallySelected : groups.find((group) => group.length > 1);
  if (conflict) {
    await updateDoc(roomRef(), {
      lottery: {
        id: `${Date.now()}`,
        status: "ready",
        playerId: conflict[0].playerId,
        playerName: conflict[0].playerName,
        entrants: conflict.map((item) => ({ memberId: item.memberId, memberName: item.memberName })),
        nominationIds: conflict.map((item) => item.id),
        round: state.room.round,
      },
    });
    openLottery();
    return;
  }
  await finalizeRound(nominations);
}

function openLottery() {
  const lottery = state.room?.lottery;
  if (!lottery) return;
  $("#lottery-player").textContent = lottery.playerName;
  $("#lottery-teams").textContent = lottery.entrants.map((item) => item.memberName).join(" × ");
  $("#lottery-ball").textContent = "?";
  $("#lottery-ball").classList.remove("spinning");
  $("#run-lottery").classList.toggle("hidden", !isHost());
  $("#close-lottery").classList.add("hidden");
  if (!$("#lottery-dialog").open) $("#lottery-dialog").showModal();
}

$("#run-lottery").addEventListener("click", async () => {
  const button = $("#run-lottery");
  button.disabled = true;
  $("#lottery-ball").classList.add("spinning");
  await new Promise((resolve) => setTimeout(resolve, 1800));
  const lottery = state.room.lottery;
  const winner = lottery.entrants[Math.floor(Math.random() * lottery.entrants.length)];
  await updateDoc(roomRef(), { lottery: { ...lottery, status: "done", winner } });
  button.disabled = false;
});

function showLotteryResult() {
  const lottery = state.room.lottery;
  if (!$("#lottery-dialog").open) openLottery();
  $("#lottery-ball").classList.remove("spinning");
  $("#lottery-ball").textContent = lottery.winner.memberName.slice(0, 1);
  $("#lottery-player").textContent = `${lottery.winner.memberName} が交渉権獲得！`;
  $("#lottery-teams").textContent = lottery.playerName;
  $("#run-lottery").classList.add("hidden");
  $("#close-lottery").classList.remove("hidden");
}

$("#close-lottery").addEventListener("click", async () => {
  $("#lottery-dialog").close();
  if (!isHost()) return;
  const lottery = state.room.lottery;
  const nominations = state.nominations.filter((item) => item.round === state.room.round);
  const winners = nominations.filter((item) => !lottery.nominationIds.includes(item.id));
  winners.push({
    round: lottery.round,
    memberId: lottery.winner.memberId,
    memberName: lottery.winner.memberName,
    playerId: lottery.playerId,
    playerName: lottery.playerName,
    viaLottery: true,
  });
  await finalizeRound(winners, lottery);
});

async function finalizeRound(nominations, lottery = null) {
  const batch = writeBatch(db);
  nominations.forEach((item) => {
    const pickRef = doc(db, "rooms", state.roomId, "picks", item.playerId);
    batch.set(pickRef, {
      round: state.room.round,
      memberId: item.memberId,
      memberName: item.memberName,
      playerId: item.playerId,
      playerName: item.playerName,
      viaLottery: Boolean(item.viaLottery),
      createdAt: serverTimestamp(),
    });
  });
  state.nominations.filter((item) => item.round === state.room.round).forEach((item) => {
    batch.delete(doc(db, "rooms", state.roomId, "nominations", item.id));
  });
  batch.update(roomRef(), { round: state.room.round + 1, lottery: null });
  await batch.commit();
  state.manualConflict.clear();
  toast(lottery ? "抽選結果を確定しました" : "指名結果を確定しました");
}

$("#reset-draft").addEventListener("click", async () => {
  if (!confirm("指名結果をすべて消して待機状態へ戻しますか？")) return;
  const batch = writeBatch(db);
  const picks = await getDocs(collection(db, "rooms", state.roomId, "picks"));
  const nominations = await getDocs(collection(db, "rooms", state.roomId, "nominations"));
  picks.forEach((item) => batch.delete(item.ref));
  nominations.forEach((item) => batch.delete(item.ref));
  batch.update(roomRef(), { status: "waiting", round: 1, turnIndex: 0, draftOrder: [], lottery: null });
  await batch.commit();
});

function escapeHtml(value = "") {
  return String(value).replace(/[&<>"']/g, (char) => ({
    "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#039;",
  })[char]);
}
