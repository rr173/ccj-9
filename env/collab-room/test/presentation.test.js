"use strict";

const test = require("node:test");
const assert = require("node:assert");
const fs = require("fs");
const os = require("os");
const path = require("path");
const { RoomManager } = require("../rooms");

function managerWithRoom() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "collab-presentation-"));
  const file = path.join(dir, "rooms.json");
  const manager = new RoomManager(file);
  const room = manager.create("演示恢复房").room;
  const presenter = manager.touchMember(room, { memberId: "owner", name: "发起人" });
  return { manager, room, presenter, file };
}

test("活动演示按原到期时间持久化，结束和过期后不复活", () => {
  const { manager, room, presenter, file } = managerWithRoom();
  const base = Date.now() + 60000;
  const started = manager.startPresentation(room, presenter, { durationMs: 60000 }, base);
  assert.equal(started.result, "started");
  manager.joinPresentation(room, { memberId: "follower", name: "跟随者" }, base + 100);
  manager.updatePresentation(room, presenter, {
    anchor: 0, selStart: 0, selEnd: 0, scrollTop: 88, scrollLeft: 3
  }, base + 200);
  manager.flushSync();

  const restored = new RoomManager(file);
  const restoredRoom = restored.get(room.id);
  assert.equal(restoredRoom.presentation.expiresAt, base + 60000);
  assert.equal(restoredRoom.presentation.view.scrollTop, 88);
  assert.deepEqual(Object.keys(restoredRoom.presentation.followers), ["follower"]);
  assert.equal(restored.expirePresentation(restoredRoom, base + 60001).reason, "expired");
  restored.flushSync();
  assert.equal(new RoomManager(file).get(room.id).presentation, null);
});

test("发起人宽限期内重连继续，超过宽限后演示结束", () => {
  const { manager, room, presenter } = managerWithRoom();
  const base = Date.now() + 60000;
  manager.startPresentation(room, presenter, { durationMs: 60000 }, base);
  const disconnected = manager.presenterDisconnected(room, "owner", base + 1000);
  assert.equal(disconnected.graceUntil, base + 16000);
  const resumed = manager.presenterReconnected(room, "owner", base + 10000);
  assert.equal(resumed.presenterConnected, true);
  assert.equal(manager.expirePresentation(room, base + 17000), null);

  manager.presenterDisconnected(room, "owner", base + 20000);
  const ended = manager.expirePresentation(room, base + 35001);
  assert.equal(ended.reason, "presenter_timeout");
  assert.equal(room.presentation, null);
});
