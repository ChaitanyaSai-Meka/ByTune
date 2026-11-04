/**
 * The room the listener is in, as main last told it (lib/rooms keeps it current). A store of its
 * own so the player, the audio engine and AutoPlay can ask "in a room?" without depending on the
 * room logic, which depends on them.
 */
import { create } from "zustand";
import type { RoomView } from "../types";

export const useRoom = create<{ view: RoomView; busy: boolean }>(() => ({ view: { state: null, me: null, offsetMs: 0 }, busy: false }));

export const inRoom = (): boolean => useRoom.getState().view.state !== null;
