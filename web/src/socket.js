import { io } from "socket.io-client";

let socket = null;

export function getSocket() {
  if (!socket) {
    const url = import.meta.env.VITE_SERVER_URL || "http://localhost:3001";
    socket = io(url, { autoConnect: true });
  }
  return socket;
}

export function disconnectSocket() {
  if (socket) {
    socket.disconnect();
    socket = null;
  }
}

// Persistent UUID stored in localStorage so the server can
// match a reconnecting browser back to its room slot.
export function getPlayerToken() {
  let token = localStorage.getItem("manhunt_player_token");
  if (!token) {
    token = crypto.randomUUID();
    localStorage.setItem("manhunt_player_token", token);
  }
  return token;
}
