"use strict";
const { contextBridge, ipcRenderer } = require("electron");

const call = (channel, ...args) => ipcRenderer.invoke(channel, ...args);

contextBridge.exposeInMainWorld("api", {
  state: () => call("state:get"),
  savePi: (addr, token) => call("pi:save", addr, token),
  addProfile: () => call("profile:add"),
  updateProfile: (id, patch) => call("profile:update", id, patch),
  removeProfile: (id, remote) => call("profile:remove", id, remote),
  status: (id) => call("session:status", id),
  ensure: (id) => call("session:ensure", id),
  cancel: (id) => call("session:cancel", id),
  newnym: (id) => call("session:newnym", id),
  setCountry: (id, cc) => call("session:country", id, cc),
  openBrowser: (id) => call("browser:open", id),
  sysEnable: (id) => call("sys:enable", id),
  sysDisable: () => call("sys:disable"),
  fastRun: (id, opt) => call("fast:run", id, opt),
  onFast: (fn) => ipcRenderer.on("fastprogress", (_e, d) => fn(d)),
  setNotify: (v) => call("settings:notify", v),
  healthCheck: (id) => call("health:check", id),
  onHealth: (fn) => ipcRenderer.on("health", (_e, d) => fn(d)),
  refreshExits: () => call("exits:refresh"),
  setDirect: (on, list) => call("settings:direct", on, list),
  saveExit: (id, ex) => call("exit:save", id, ex),
  removeExit: (id, ip) => call("exit:remove", id, ip),
  useExit: (id, ip) => call("exit:use", id, ip),
  setKillSwitch: (on) => call("ks:set", on),
  sysTest: () => call("sys:test"),
  checkIp: (id) => call("ip:check", id),
  pickBrowser: () => call("browser:pick"),
  onProgress: (fn) => ipcRenderer.on("progress", (_e, d) => fn(d)),
});
