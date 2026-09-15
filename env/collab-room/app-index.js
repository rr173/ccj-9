"use strict";
/* 首页：创建房间 + 房间列表轮询 */

const form = document.getElementById("create-form");
const nameInput = document.getElementById("room-name");
const errorBox = document.getElementById("create-error");
const listBody = document.getElementById("room-list");

function esc(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
}
function fmtTime(iso) {
  try { return new Date(iso).toLocaleString(); } catch (e) { return iso; }
}

async function loadRooms() {
  try {
    const res = await fetch("/api/rooms");
    const data = await res.json();
    if (!data.rooms || !data.rooms.length) {
      listBody.innerHTML = '<tr><td colspan="6" class="muted">还没有房间，先创建一个吧。</td></tr>';
      return;
    }
    listBody.innerHTML = data.rooms.map(r => {
      const online = "—";
      return "<tr>" +
        '<td><a class="room-link" href="/room.html?id=' + encodeURIComponent(r.id) + '">' + esc(r.name) + "</a></td>" +
        "<td>" + r.rev + "</td>" +
        "<td>" + r.members + " " + esc(online) + "</td>" +
        "<td>" + (r.openConflicts ? '<span class="badge warn">' + r.openConflicts + "</span>" : "0") + "</td>" +
        "<td>" + esc(fmtTime(r.updatedAt)) + "</td>" +
        '<td><a class="btn small" href="/room.html?id=' + encodeURIComponent(r.id) + '">进入</a></td>' +
        "</tr>";
    }).join("");
  } catch (e) {
    listBody.innerHTML = '<tr><td colspan="6" class="muted">列表加载失败，正在重试…</td></tr>';
  }
}

form.addEventListener("submit", async (ev) => {
  ev.preventDefault();
  errorBox.hidden = true;
  const name = nameInput.value.trim();
  if (!name) { errorBox.textContent = "房间名称不能为空"; errorBox.hidden = false; return; }
  try {
    const res = await fetch("/api/rooms", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: name })
    });
    const data = await res.json();
    if (!res.ok) {
      const map = { empty_name: "名称不能为空", name_too_long: "名称过长（≤100 字）", too_many_rooms: "房间数量已达上限" };
      errorBox.textContent = map[data.error] || ("创建失败：" + (data.error || res.status));
      errorBox.hidden = false;
      return;
    }
    location.href = "/room.html?id=" + encodeURIComponent(data.room.id);
  } catch (e) {
    errorBox.textContent = "网络错误：" + e.message;
    errorBox.hidden = false;
  }
});

loadRooms();
setInterval(loadRooms, 3000);
