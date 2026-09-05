import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import { authApi } from '../api/client';
import { connect, disconnect } from '../api/websocket';
import { deleteCurrentUserDb, reopenForUser } from '../db/offlineDb';
import {
  assertAuthGenerationLeaseValid,
  captureAuthGenerationLease,
  setAuthed,
} from '../sync/authGate';
import { registerSyncTriggers, unregisterSyncTriggers } from '../sync/syncTriggers';
import { tripSyncManager } from '../sync/tripSyncManager';
import { clearAppearanceSnapshot } from '../theme/applyAppearance';
import type { User } from '../types';
import { getApiErrorMessage } from '../types';
import { clearSignedOut, markSignedOut } from '../utils/signedOut';
import { forgetStartDestination } from '../utils/startDestination';
import { forgetServerLanguage, resetSettingsForAccountTransition } from './settingsStore';
import { clearAllPluginSessions } from './pluginStore';
import { useTripStore } from './tripStore';
import { useSystemNoticeStore } from './systemNoticeStore.js';

interface AuthResponse {
  user: User;
  token: string;
}

export type LoginResult = AuthResponse | { mfa_required: true; mfa_token: string };

interface AvatarResponse {
  avatar_url: string;
}

interface AuthState {
  user: User | null;
  isAuthenticated: boolean;
  isLoading: boolean;
  /** The auth check (loadUser) failed for a non-401 reason while we were online —
   *  the server was unreachable or erroring. Surfaced by the UI so a backend/IdP
   *  outage doesn't render as a blank, error-free page that looks like lost data.
   *  Transient, never persisted. #1283 */
  authCheckFailed: boolean;
  /** The user pressed "log out" — as opposed to a session that simply ended.
   *  Read by ProtectedRoute: a deliberate sign-out should not leave a
   *  ?redirect= pointing back at the page they just left. Transient. */
  loggingOut: boolean;
  error: string | null;
  /** The operator of this install owns its configuration, not the admin. */
  managed: boolean;
  demoMode: boolean;
  devMode: boolean;
  isPrerelease: boolean;
  appVersion: string;
  hasMapsKey: boolean;
  serverTimezone: string;
  /** Server policy: all users must enable MFA */
  appRequireMfa: boolean;
  tripRemindersEnabled: boolean;
  placesPhotosEnabled: boolean;
  placesAutocompleteEnabled: boolean;
  placesDetailsEnabled: boolean;
  placesEnrichEnabled: boolean;
  /** Compatibility alias retained while the fork's enrichment surfaces move to the v4 name. */
  placesEnrichmentEnabled: boolean;

  login: (email: string, password: string, rememberMe?: boolean) => Promise<LoginResult>;
  completeMfaLogin: (mfaToken: string, code: string, rememberMe?: boolean) => Promise<AuthResponse>;
  register: (username: string, email: string, password: string, invite_token?: string) => Promise<AuthResponse>;
  logout: () => Promise<void>;
  /**
   * Pass `{ silent: true }` to refresh the user without toggling global
   * isLoading. Resolves false only when a newer auth action/logout supersedes
   * this continuation, so redirecting callers can stop without surfacing an
   * error.
   */
  loadUser: (opts?: { silent?: boolean }) => Promise<boolean>;
  updateMapsKey: (key: string | null) => Promise<void>;
  updateApiKeys: (keys: Record<string, string | null>) => Promise<void>;
  updateProfile: (profileData: Partial<User>) => Promise<void>;
  uploadAvatar: (file: File) => Promise<AvatarResponse>;
  deleteAvatar: () => Promise<void>;
  setManaged: (val: boolean) => void;
  setDemoMode: (val: boolean) => void;
  setDevMode: (val: boolean) => void;
  setIsPrerelease: (val: boolean) => void;
  setAppVersion: (val: string) => void;
  setHasMapsKey: (val: boolean) => void;
  setServerTimezone: (tz: string) => void;
  setAppRequireMfa: (val: boolean) => void;
  setTripRemindersEnabled: (val: boolean) => void;
  setPlacesPhotosEnabled: (val: boolean) => void;
  setPlacesAutocompleteEnabled: (val: boolean) => void;
  setPlacesDetailsEnabled: (val: boolean) => void;
  setPlacesEnrichEnabled: (val: boolean) => void;
  setPlacesEnrichmentEnabled: (val: boolean) => void;
  demoLogin: () => Promise<AuthResponse>;
}

// One generation for every auth continuation. Starting another attempt or
// logging out invalidates older responses before they can touch state.
let authSequence = 0;
let activeAuthRequest: AbortController | null = null;
let activeLogoutBarrier: Promise<void> | null = null;
const LOGOUT_REQUEST_TIMEOUT_MS = 10_000;
const ACCOUNT_CACHE_NAMES = ['api-data', 'user-uploads', 'map-tiles', 'gl-map-styles', 'mapbox-tiles', 'gl-map-offline'] as const;
const PENDING_SERVER_LOGOUT_KEY = 'trek_pending_server_logout';

/** Wait until the current user's local data and session teardown has finished. */
export async function awaitAuthTeardown(): Promise<void> {
  while (activeLogoutBarrier) await activeLogoutBarrier;
}

export class AuthAttemptCancelledError extends Error {
  constructor() {
    super('Authentication attempt was cancelled');
    this.name = 'AuthAttemptCancelledError';
  }
}

export function isAuthAttemptCancelled(error: unknown): boolean {
  return error instanceof AuthAttemptCancelledError
    || (!!error && typeof error === 'object' && 'name' in error
      && (error as { name?: unknown }).name === 'AuthAttemptCancelledError');
}

function beginAuthAttempt() {
  const seq = ++authSequence;
  activeAuthRequest?.abort();
  const request = new AbortController();
  activeAuthRequest = request;

  return {
    signal: request.signal,
    isCurrent: () => seq === authSequence && activeAuthRequest === request && !request.signal.aborted,
    finish: () => {
      if (activeAuthRequest === request) activeAuthRequest = null;
    },
  };
}

/**
 * Join passkey/OIDC flows to the store's auth sequence. A flow started during
 * logout waits for teardown; a later logout aborts and invalidates it.
 */
export function beginExternalAuthAttempt(): ReturnType<typeof beginAuthAttempt> | Promise<ReturnType<typeof beginAuthAttempt>> {
  if (!activeLogoutBarrier && !hasPendingServerLogout()) return beginAuthAttempt();
  return (async () => {
    while (activeLogoutBarrier) await activeLogoutBarrier;
    if (!(await settlePendingServerLogout())) {
      throw new Error('The previous logout could not be confirmed. Reconnect and try again.');
    }
    return beginAuthAttempt();
  })();
}

function cancelAuthAttempts(): void {
  authSequence++;
  activeAuthRequest?.abort();
  activeAuthRequest = null;
}

function bestEffortCleanup(label: string, cleanup: () => void): void {
  try {
    cleanup();
  } catch (err) {
    console.error(`[auth] ${label} cleanup failed`, err);
  }
}

function clearAccountMirrors(): void {
  bestEffortCleanup('appearance snapshot', clearAppearanceSnapshot);
  bestEffortCleanup('plugin sessions', clearAllPluginSessions);
  bestEffortCleanup('start destination', forgetStartDestination);
  bestEffortCleanup('server language', forgetServerLanguage);
}

async function clearAccountCaches(): Promise<void> {
  if (typeof caches === 'undefined') return;
  await Promise.all(ACCOUNT_CACHE_NAMES.map(async (name) => {
    try {
      await caches.delete(name);
    } catch (err) {
      console.error(`[auth] ${name} cache cleanup failed`, err);
    }
  }));
  await clearWorkboxExpirationMetadata(ACCOUNT_CACHE_NAMES);
}

async function clearWorkboxExpirationMetadata(cacheNames: readonly string[]): Promise<void> {
  if (typeof indexedDB === 'undefined') return;
  try {
    await new Promise<void>((resolve, reject) => {
      let created = false;
      const open = indexedDB.open('workbox-expiration');
      open.onupgradeneeded = () => { created = true; };
      open.onerror = () => reject(open.error ?? new Error('Could not open Workbox metadata'));
      open.onsuccess = () => {
        const database = open.result;
        if (created || !database.objectStoreNames.contains('cache-entries')) {
          database.close();
          if (created) indexedDB.deleteDatabase('workbox-expiration');
          resolve();
          return;
        }
        const transaction = database.transaction('cache-entries', 'readwrite');
        const index = transaction.objectStore('cache-entries').index('cacheName');
        transaction.oncomplete = () => { database.close(); resolve(); };
        transaction.onerror = () => { database.close(); reject(transaction.error ?? new Error('Could not clear Workbox metadata')); };
        transaction.onabort = () => { database.close(); reject(transaction.error ?? new Error('Could not clear Workbox metadata')); };
        for (const cacheName of cacheNames) {
          const cursor = index.openCursor(IDBKeyRange.only(cacheName));
          cursor.onsuccess = () => {
            const row = cursor.result;
            if (!row) return;
            row.delete();
            row.continue();
          };
        }
      };
    });
  } catch (err) {
    console.error('[auth] Workbox cache metadata cleanup failed', err);
  }
}

function setPendingServerLogout(pending: boolean): void {
  try {
    if (pending) localStorage.setItem(PENDING_SERVER_LOGOUT_KEY, '1');
    else localStorage.removeItem(PENDING_SERVER_LOGOUT_KEY);
  } catch (err) {
    // If persistence is unavailable, this tab still remains auth-closed through
    // its in-memory barrier; report that a reload cannot retain the safeguard.
    console.error('[auth] pending logout marker update failed', err);
  }
}

function hasPendingServerLogout(): boolean {
  try {
    return localStorage.getItem(PENDING_SERVER_LOGOUT_KEY) === '1';
  } catch {
    return true;
  }
}

async function requestServerLogout(): Promise<Response | null> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      controller.abort();
      console.error('[auth] server logout request timed out');
      resolve(null);
    }, LOGOUT_REQUEST_TIMEOUT_MS);
  });
  try {
    const request = fetch('/api/auth/logout', {
      method: 'POST',
      credentials: 'include',
      signal: controller.signal,
    }).catch((err) => {
      console.error('[auth] server logout request failed', err);
      return null;
    });
    return await Promise.race([request, timeout]);
  } finally {
    if (timer !== undefined) clearTimeout(timer);
  }
}

async function settlePendingServerLogout(): Promise<boolean> {
  if (!hasPendingServerLogout()) return true;
  const response = await requestServerLogout();
  const settled = !!response?.ok;
  if (settled) setPendingServerLogout(false);
  return settled;
}

/**
 * Mark the session authenticated and point the offline DB at this user's scoped
 * database before any background sync runs, so cached data never crosses users.
 */
async function onAuthSuccess(userId: number, isCurrent: () => boolean = () => true): Promise<boolean> {
  if (!isCurrent()) return false;
  setAuthed(true, userId);
  // Whatever brought them back in - password, SSO, MFA, demo, a restored
  // session - the tab is no longer "just signed out", so the login page may
  // auto-SSO again next time.
  clearSignedOut();
  try {
    await reopenForUser(userId);
  } catch (err) {
    if (isCurrent()) console.error('[auth] failed to open user-scoped offline DB', err);
  }
  if (!isCurrent()) return false;
  // logout() tears the triggers down, and App's mount effect never runs again in
  // an SPA session, so a second login in the same tab would leave the mutation
  // queue without a flush trigger. Re-registering is a no-op while they are up.
  registerSyncTriggers();
  // has_maps_key is user-scoped. Refresh it for every authenticated identity;
  // App's mount-only anonymous config probe cannot safely carry it across SPA
  // account switches.
  useAuthStore.setState({ hasMapsKey: false });
  try {
    const config = await authApi.getAppConfig();
    if (!isCurrent()) return false;
    useAuthStore.setState({ hasMapsKey: !!config?.has_maps_key });
  } catch (err) {
    if (isCurrent()) console.error('[auth] failed to refresh user capabilities', err);
  }
  return true;
}

export const useAuthStore = create<AuthState>()(
  persist(
    (set, get) => ({
      user: null,
      isAuthenticated: false,
      isLoading: true,
      authCheckFailed: false,
      loggingOut: false,
      error: null,
      managed: false,
      demoMode: localStorage.getItem('demo_mode') === 'true',
      devMode: false,
      isPrerelease: false,
      appVersion: '',
      hasMapsKey: false,
      serverTimezone: Intl.DateTimeFormat().resolvedOptions().timeZone,
      appRequireMfa: false,
      tripRemindersEnabled: false,
      placesPhotosEnabled: true,
      placesAutocompleteEnabled: true,
      placesDetailsEnabled: true,
      placesEnrichEnabled: true,
      placesEnrichmentEnabled: true,

      login: async (email: string, password: string, rememberMe?: boolean) => {
        // Keep the no-barrier path synchronous through beginAuthAttempt: an
        // unconditional await here lets a same-tick logout invalidate the new
        // attempt before its sequence is captured.
        while (activeLogoutBarrier) await activeLogoutBarrier;
        if (hasPendingServerLogout() && !(await settlePendingServerLogout())) {
          throw new Error('The previous logout could not be confirmed. Reconnect and try again.');
        }
        const attempt = beginAuthAttempt();
        set({ isLoading: true, error: null });
        try {
          const data = (await authApi.login({ email, password, remember_me: rememberMe }, attempt.signal)) as AuthResponse & {
            mfa_required?: boolean;
            mfa_token?: string;
          };
          if (!attempt.isCurrent()) throw new AuthAttemptCancelledError();
          if (data.mfa_required && data.mfa_token) {
            set({ isLoading: false, error: null });
            return { mfa_required: true as const, mfa_token: data.mfa_token };
          }
          set({
            user: data.user,
            isAuthenticated: true,
            loggingOut: false,
            isLoading: false,
            error: null,
          });
          if (!(await onAuthSuccess(data.user.id, attempt.isCurrent)) || !attempt.isCurrent()) {
            throw new AuthAttemptCancelledError();
          }
          connect();
          tripSyncManager.syncAll().catch(console.error);
          if (!data.user?.must_change_password) {
            useSystemNoticeStore.getState().fetch();
          }
          return data as AuthResponse;
        } catch (err: unknown) {
          if (!attempt.isCurrent() || isAuthAttemptCancelled(err)) throw new AuthAttemptCancelledError();
          const error = getApiErrorMessage(err, 'Login failed');
          set({ isLoading: false, error });
          throw new Error(error);
        } finally {
          attempt.finish();
        }
      },

      completeMfaLogin: async (mfaToken: string, code: string, rememberMe?: boolean) => {
        while (activeLogoutBarrier) await activeLogoutBarrier;
        if (hasPendingServerLogout() && !(await settlePendingServerLogout())) {
          throw new Error('The previous logout could not be confirmed. Reconnect and try again.');
        }
        const attempt = beginAuthAttempt();
        set({ isLoading: true, error: null });
        try {
          const data = await authApi.verifyMfaLogin({
            mfa_token: mfaToken,
            code: code.replace(/\s/g, ''),
            remember_me: rememberMe,
          }, attempt.signal);
          if (!attempt.isCurrent()) throw new AuthAttemptCancelledError();
          set({
            user: data.user,
            isAuthenticated: true,
            loggingOut: false,
            isLoading: false,
            error: null,
          });
          if (!(await onAuthSuccess(data.user.id, attempt.isCurrent)) || !attempt.isCurrent()) {
            throw new AuthAttemptCancelledError();
          }
          connect();
          tripSyncManager.syncAll().catch(console.error);
          if (!data.user?.must_change_password) {
            useSystemNoticeStore.getState().fetch();
          }
          return data as AuthResponse;
        } catch (err: unknown) {
          if (!attempt.isCurrent() || isAuthAttemptCancelled(err)) throw new AuthAttemptCancelledError();
          const error = getApiErrorMessage(err, 'Verification failed');
          set({ isLoading: false, error });
          throw new Error(error);
        } finally {
          attempt.finish();
        }
      },

      register: async (username: string, email: string, password: string, invite_token?: string) => {
        while (activeLogoutBarrier) await activeLogoutBarrier;
        if (hasPendingServerLogout() && !(await settlePendingServerLogout())) {
          throw new Error('The previous logout could not be confirmed. Reconnect and try again.');
        }
        const attempt = beginAuthAttempt();
        set({ isLoading: true, error: null });
        try {
          const data = await authApi.register({ username, email, password, invite_token }, attempt.signal);
          if (!attempt.isCurrent()) throw new AuthAttemptCancelledError();
          set({
            user: data.user,
            isAuthenticated: true,
            loggingOut: false,
            isLoading: false,
            error: null,
          });
          if (!(await onAuthSuccess(data.user.id, attempt.isCurrent)) || !attempt.isCurrent()) {
            throw new AuthAttemptCancelledError();
          }
          connect();
          tripSyncManager.syncAll().catch(console.error);
          useSystemNoticeStore.getState().fetch();
          return data;
        } catch (err: unknown) {
          if (!attempt.isCurrent() || isAuthAttemptCancelled(err)) throw new AuthAttemptCancelledError();
          const error = getApiErrorMessage(err, 'Registration failed');
          set({ isLoading: false, error });
          throw new Error(error);
        } finally {
          attempt.finish();
        }
      },

      logout: async () => {
        if (activeLogoutBarrier) {
          await activeLogoutBarrier;
          return;
        }
        let releaseLogoutBarrier!: () => void;
        const logoutBarrier = new Promise<void>(resolve => {
          releaseLogoutBarrier = resolve;
        });
        activeLogoutBarrier = logoutBarrier;
        try {
          // Invalidate auth/sync leases before any teardown can yield or fail.
          cancelAuthAttempts();
          setAuthed(false);
          setPendingServerLogout(true);
          set({ isAuthenticated: false, loggingOut: true, isLoading: false, hasMapsKey: false });

          bestEffortCleanup('trip state', () => useTripStore.getState().resetTrip({ clearUserData: true }));
          bestEffortCleanup('signed-out marker', markSignedOut);
          bestEffortCleanup('sync triggers', unregisterSyncTriggers);
          bestEffortCleanup('websocket', disconnect);
          bestEffortCleanup('system notices', () => useSystemNoticeStore.getState().reset());
          clearAccountMirrors();
          bestEffortCleanup('settings state', resetSettingsForAccountTransition);

          // The server tombstones this session lineage before clearing the cookie.
          const logoutResponse = await requestServerLogout();
          if (logoutResponse?.ok) setPendingServerLogout(false);
          if (logoutResponse && !logoutResponse.ok) {
            // The local identity still has to be removed, but do not disguise a
            // failed durable server-side tombstone as a normal logout.
            console.error(`[auth] server logout failed with status ${logoutResponse.status}`);
          }
          await clearAccountCaches();
          await deleteCurrentUserDb().catch(console.error);
        } finally {
          // No optional cleanup failure may leave the old identity persisted or
          // release the barrier while auth still appears live.
          set({
            user: null,
            isAuthenticated: false,
            authCheckFailed: false,
            error: null,
          });
          if (activeLogoutBarrier === logoutBarrier) activeLogoutBarrier = null;
          releaseLogoutBarrier();
        }
      },

      loadUser: async (opts?: { silent?: boolean }) => {
        while (activeLogoutBarrier) await activeLogoutBarrier;
        if (hasPendingServerLogout() && !(await settlePendingServerLogout())) {
          setAuthed(false);
          set({ user: null, isAuthenticated: false, isLoading: false, hasMapsKey: false });
          return false;
        }
        const seq = authSequence;
        const isCurrent = () => seq === authSequence;
        const silent = !!opts?.silent;
        if (!silent) set({ isLoading: true });
        try {
          const data = await authApi.me();
          if (!isCurrent()) return false; // stale response — login/register/logout happened meanwhile
          set({
            user: data.user,
            isAuthenticated: true,
            loggingOut: false,
            isLoading: false,
            authCheckFailed: false,
          });
          if (!(await onAuthSuccess(data.user.id, isCurrent)) || !isCurrent()) return false;
          connect();
          return true;
        } catch (err: unknown) {
          if (!isCurrent()) return false; // stale response — ignore
          const status =
            err && typeof err === 'object' && 'response' in err
              ? (err as { response?: { status?: number } }).response?.status
              : undefined;
          if (status === 401) {
            // Invalidate every auth/trip continuation before exposing the
            // signed-out state. A late request that passed the server guard
            // before this 401 must not repopulate the old account.
            cancelAuthAttempts();
            setAuthed(false);
            bestEffortCleanup('trip state', () => useTripStore.getState().resetTrip({ clearUserData: true }));
            bestEffortCleanup('sync triggers', unregisterSyncTriggers);
            bestEffortCleanup('websocket', disconnect);
            bestEffortCleanup('system notices', () => useSystemNoticeStore.getState().reset());
            clearAccountMirrors();
            bestEffortCleanup('settings state', resetSettingsForAccountTransition);
            await clearAccountCaches();
            set({
              user: null,
              isAuthenticated: false,
              loggingOut: false,
              isLoading: false,
              authCheckFailed: false,
              hasMapsKey: false,
            });
          } else if (status === undefined && typeof navigator !== 'undefined' && !navigator.onLine) {
            // Genuinely offline — keep the persisted session so the PWA serves cached
            // data without a scary error. This is the offline-first happy path.
            set({ isLoading: false });
          } else {
            // Server erroring (5xx) or unreachable while we're online: keep the session
            // (don't eject the user over a transient outage), but flag it so the UI can
            // say "couldn't reach the server" instead of showing a blank, error-free
            // page that looks like the user's trips were lost. #1283
            set({ isLoading: false, authCheckFailed: true });
          }
          return true;
        }
      },

      updateMapsKey: async (key: string | null) => {
        const authLease = captureAuthGenerationLease();
        try {
          await authApi.updateMapsKey(key);
          assertAuthGenerationLeaseValid(authLease);
          set((state) => ({
            user: state.user ? { ...state.user, maps_api_key: key || null } : null,
            hasMapsKey: !!key,
          }));
        } catch (err: unknown) {
          assertAuthGenerationLeaseValid(authLease);
          throw new Error(getApiErrorMessage(err, 'Error saving API key'));
        }
      },

      updateApiKeys: async (keys: Record<string, string | null>) => {
        const authLease = captureAuthGenerationLease();
        try {
          const data = await authApi.updateApiKeys(keys);
          assertAuthGenerationLeaseValid(authLease);
          set({ user: data.user });
          if ('maps_api_key' in keys) {
            set({ hasMapsKey: !!keys.maps_api_key });
          }
        } catch (err: unknown) {
          assertAuthGenerationLeaseValid(authLease);
          throw new Error(getApiErrorMessage(err, 'Error saving API keys'));
        }
      },

      updateProfile: async (profileData: Partial<User>) => {
        const authLease = captureAuthGenerationLease();
        try {
          const data = await authApi.updateSettings(profileData);
          assertAuthGenerationLeaseValid(authLease);
          set({ user: data.user });
        } catch (err: unknown) {
          assertAuthGenerationLeaseValid(authLease);
          throw new Error(getApiErrorMessage(err, 'Error updating profile'));
        }
      },

      uploadAvatar: async (file: File) => {
        const authLease = captureAuthGenerationLease();
        const formData = new FormData();
        formData.append('avatar', file);
        const data = await authApi.uploadAvatar(formData);
        assertAuthGenerationLeaseValid(authLease);
        set((state) => ({ user: state.user ? { ...state.user, avatar_url: data.avatar_url } : null }));
        return data;
      },

      deleteAvatar: async () => {
        const authLease = captureAuthGenerationLease();
        await authApi.deleteAvatar();
        assertAuthGenerationLeaseValid(authLease);
        set((state) => ({ user: state.user ? { ...state.user, avatar_url: null } : null }));
      },

      // Not persisted, unlike demoMode above: two installs can share a browser
      // profile, and a stale 'this one is managed' would then take settings away
      // from an admin on an install that never set the flag. Re-read on every boot
      // from app-config, which is one request the app makes anyway.
      setManaged: (val: boolean) => set({ managed: val }),

      setDemoMode: (val: boolean) => {
        if (val) localStorage.setItem('demo_mode', 'true');
        else localStorage.removeItem('demo_mode');
        set({ demoMode: val });
      },

      setDevMode: (val: boolean) => set({ devMode: val }),
      setIsPrerelease: (val: boolean) => set({ isPrerelease: val }),
      setAppVersion: (val: string) => set({ appVersion: val }),
      setHasMapsKey: (val: boolean) => set({ hasMapsKey: val }),
      setServerTimezone: (tz: string) => set({ serverTimezone: tz }),
      setAppRequireMfa: (val: boolean) => set({ appRequireMfa: val }),
      setTripRemindersEnabled: (val: boolean) => set({ tripRemindersEnabled: val }),
      setPlacesPhotosEnabled: (val: boolean) => set({ placesPhotosEnabled: val }),
      setPlacesAutocompleteEnabled: (val: boolean) => set({ placesAutocompleteEnabled: val }),
      setPlacesDetailsEnabled: (val: boolean) => set({ placesDetailsEnabled: val }),
      setPlacesEnrichEnabled: (val: boolean) => set({ placesEnrichEnabled: val, placesEnrichmentEnabled: val }),
      setPlacesEnrichmentEnabled: (val: boolean) => set({ placesEnrichEnabled: val, placesEnrichmentEnabled: val }),

      demoLogin: async () => {
        while (activeLogoutBarrier) await activeLogoutBarrier;
        if (hasPendingServerLogout() && !(await settlePendingServerLogout())) {
          throw new Error('The previous logout could not be confirmed. Reconnect and try again.');
        }
        const attempt = beginAuthAttempt();
        set({ isLoading: true, error: null });
        try {
          const data = await authApi.demoLogin(attempt.signal);
          if (!attempt.isCurrent()) throw new AuthAttemptCancelledError();
          set({
            user: data.user,
            isAuthenticated: true,
            loggingOut: false,
            isLoading: false,
            demoMode: true,
            error: null,
          });
          if (!(await onAuthSuccess(data.user.id, attempt.isCurrent)) || !attempt.isCurrent()) {
            throw new AuthAttemptCancelledError();
          }
          connect();
          return data;
        } catch (err: unknown) {
          if (!attempt.isCurrent() || isAuthAttemptCancelled(err)) throw new AuthAttemptCancelledError();
          const error = getApiErrorMessage(err, 'Demo login failed');
          set({ isLoading: false, error });
          throw new Error(error);
        } finally {
          attempt.finish();
        }
      },
    }),
    {
      name: 'trek_auth_snapshot',
      // Only persist the minimal user snapshot needed to avoid redirecting to
      // login when the PWA reopens offline. The JWT remains in the httpOnly
      // cookie and is still validated by the server on every request.
      // maps_api_key is intentionally excluded — it's an API key that should
      // not sit in localStorage any longer than the active session requires.
      partialize: (state) => ({
        isAuthenticated: state.isAuthenticated,
        user: state.user
          ? {
              id: state.user.id,
              username: state.user.username,
              email: state.user.email,
              role: state.user.role,
              avatar_url: state.user.avatar_url,
              mfa_enabled: state.user.mfa_enabled,
              must_change_password: state.user.must_change_password,
            }
          : null,
      }),
    }
  )
);
