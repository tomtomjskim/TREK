import { describe, it, expect, beforeEach, vi } from 'vitest';
import React from 'react';
import { act, render, screen, waitFor, fireEvent, within } from '../../tests/helpers/render';
import { resetAllStores, seedStore } from '../../tests/helpers/store';
import { buildUser } from '../../tests/helpers/factories';
import { useAuthStore } from '../store/authStore';
import { useVacayStore } from '../store/vacayStore';
import VacayPage from './VacayPage';
import * as websocket from '../api/websocket';

vi.mock('../components/Vacay/VacayCalendar', () => ({
  default: () => <div data-testid="vacay-calendar" />,
}));

vi.mock('../components/Vacay/VacayPersons', () => ({
  default: () => <div data-testid="vacay-persons" />,
}));

vi.mock('../components/Vacay/VacayStats', () => ({
  default: () => <div data-testid="vacay-stats" />,
}));

vi.mock('../components/Vacay/VacaySettings', () => ({
  default: ({ onClose }: { onClose: () => void }) => (
    <div data-testid="vacay-settings">
      <button data-testid="vacay-settings-close" onClick={onClose}>
        Close settings
      </button>
    </div>
  ),
}));

vi.mock('../components/Layout/Navbar', () => ({
  default: () => <nav data-testid="navbar" />,
}));

vi.mock('../api/websocket', () => ({
  addListener: vi.fn(),
  removeListener: vi.fn(),
}));

const makeVacayState = (overrides = {}) => ({
  years: [2025],
  selectedYear: 2025,
  loading: false,
  isFused: false,
  pendingInvites: [] as any[],
  incomingInvites: [] as any[],
  plan: null,
  loadAll: vi.fn().mockResolvedValue(undefined),
  loadPlan: vi.fn().mockResolvedValue(undefined),
  loadEntries: vi.fn().mockResolvedValue(undefined),
  loadStats: vi.fn().mockResolvedValue(undefined),
  loadHolidays: vi.fn().mockResolvedValue(undefined),
  setSelectedYear: vi.fn(),
  addYear: vi.fn(),
  removeYear: vi.fn().mockResolvedValue(undefined),
  acceptInvite: vi.fn(),
  declineInvite: vi.fn(),
  ...overrides,
});

describe('VacayPage', () => {
  beforeEach(() => {
    resetAllStores();
    vi.clearAllMocks();
    seedStore(useAuthStore, { isAuthenticated: true, user: buildUser() });
    seedStore(useVacayStore, makeVacayState() as any);
  });

  // FE-PAGE-VACAY-001
  it('shows loading spinner when loading=true', () => {
    seedStore(useVacayStore, makeVacayState({ loading: true }) as any);
    render(<VacayPage />);
    expect(document.querySelector('.animate-spin')).toBeInTheDocument();
    expect(screen.queryByTestId('vacay-calendar')).not.toBeInTheDocument();
  });

  // FE-PAGE-VACAY-002
  it('renders main layout when not loading', async () => {
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getByTestId('vacay-calendar')).toBeInTheDocument();
      expect(screen.getByTestId('vacay-persons')).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-003
  it('displays the selected year', async () => {
    seedStore(useVacayStore, makeVacayState({ selectedYear: 2025 }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      // The large year display in the sidebar year selector
      const instances = screen.getAllByText('2025');
      expect(instances.length).toBeGreaterThan(0);
    });
  });

  // FE-PAGE-VACAY-004
  it('calls loadAll on mount', () => {
    const mockLoadAll = vi.fn().mockResolvedValue(undefined);
    seedStore(useVacayStore, makeVacayState({ loadAll: mockLoadAll }) as any);
    render(<VacayPage />);
    expect(mockLoadAll).toHaveBeenCalledTimes(1);
  });

  // FE-PAGE-VACAY-005
  it('opens settings modal on settings button click', async () => {
    render(<VacayPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /settings/i })[0]);
    await waitFor(() => {
      expect(screen.getByTestId('vacay-settings')).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-006
  it('closes settings modal via close callback', async () => {
    render(<VacayPage />);
    fireEvent.click(screen.getAllByRole('button', { name: /settings/i })[0]);
    await waitFor(() => {
      expect(screen.getByTestId('vacay-settings')).toBeInTheDocument();
    });
    fireEvent.click(screen.getByTestId('vacay-settings-close'));
    await waitFor(() => {
      expect(screen.queryByTestId('vacay-settings')).not.toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-007
  it('shows all years in the year selector', async () => {
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025 }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getAllByText('2024')[0]).toBeInTheDocument();
      expect(screen.getAllByText('2025')[0]).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-008
  it('opens the delete year modal from the selected-year removal action', async () => {
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025 }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    expect(await screen.findByRole('alertdialog', { name: /remove 2025/i })).toBeInTheDocument();
  });

  // FE-PAGE-VACAY-009
  it('shows incoming invite overlay with username and action buttons', async () => {
    seedStore(useVacayStore, makeVacayState({
      incomingInvites: [{ plan_id: 99, owner_username: 'bob' }],
    }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getByText('bob')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
      expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-010
  it('calls acceptInvite with plan_id on accept button click', async () => {
    const mockAcceptInvite = vi.fn();
    seedStore(useVacayStore, makeVacayState({
      incomingInvites: [{ plan_id: 99, owner_username: 'bob' }],
      acceptInvite: mockAcceptInvite,
    }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /accept/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /accept/i }));
    expect(mockAcceptInvite).toHaveBeenCalledWith(99);
  });

  // FE-PAGE-VACAY-011
  it('calls declineInvite with plan_id on decline button click', async () => {
    const mockDeclineInvite = vi.fn();
    seedStore(useVacayStore, makeVacayState({
      incomingInvites: [{ plan_id: 99, owner_username: 'bob' }],
      declineInvite: mockDeclineInvite,
    }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getByRole('button', { name: /decline/i })).toBeInTheDocument();
    });
    fireEvent.click(screen.getByRole('button', { name: /decline/i }));
    expect(mockDeclineInvite).toHaveBeenCalledWith(99);
  });

  // FE-PAGE-VACAY-012
  it('registers WebSocket listener on mount and removes it on unmount', () => {
    const addListenerMock = websocket.addListener as ReturnType<typeof vi.fn>;
    const removeListenerMock = websocket.removeListener as ReturnType<typeof vi.fn>;
    const { unmount } = render(<VacayPage />);
    expect(addListenerMock).toHaveBeenCalledTimes(1);
    unmount();
    expect(removeListenerMock).toHaveBeenCalledTimes(1);
  });

  // FE-PAGE-VACAY-013: WebSocket vacay:update triggers loadPlan + loadEntries + loadStats
  it('handles vacay:update WebSocket message', () => {
    const mockLoadPlan = vi.fn().mockResolvedValue(undefined);
    const mockLoadEntries = vi.fn().mockResolvedValue(undefined);
    const mockLoadStats = vi.fn().mockResolvedValue(undefined);
    const addListenerMock = websocket.addListener as ReturnType<typeof vi.fn>;
    seedStore(useVacayStore, makeVacayState({ loadPlan: mockLoadPlan, loadEntries: mockLoadEntries, loadStats: mockLoadStats }) as any);
    render(<VacayPage />);
    const handler = addListenerMock.mock.calls[0][0];
    handler({ type: 'vacay:update' });
    expect(mockLoadPlan).toHaveBeenCalled();
    expect(mockLoadEntries).toHaveBeenCalledWith(2025);
    expect(mockLoadStats).toHaveBeenCalledWith(2025);
  });

  // FE-PAGE-VACAY-014: WebSocket vacay:settings also calls loadAll
  it('handles vacay:settings WebSocket message', () => {
    const mockLoadAll = vi.fn().mockResolvedValue(undefined);
    const mockLoadPlan = vi.fn().mockResolvedValue(undefined);
    const addListenerMock = websocket.addListener as ReturnType<typeof vi.fn>;
    seedStore(useVacayStore, makeVacayState({ loadAll: mockLoadAll, loadPlan: mockLoadPlan }) as any);
    render(<VacayPage />);
    const handler = addListenerMock.mock.calls[0][0];
    // loadAll is called once on mount, reset to track the WS-triggered call
    mockLoadAll.mockClear();
    handler({ type: 'vacay:settings' });
    expect(mockLoadAll).toHaveBeenCalled();
    expect(mockLoadPlan).toHaveBeenCalled();
  });

  // FE-PAGE-VACAY-015: WebSocket vacay:invite calls loadAll
  it('handles vacay:invite WebSocket message', () => {
    const mockLoadAll = vi.fn().mockResolvedValue(undefined);
    const addListenerMock = websocket.addListener as ReturnType<typeof vi.fn>;
    seedStore(useVacayStore, makeVacayState({ loadAll: mockLoadAll }) as any);
    render(<VacayPage />);
    const handler = addListenerMock.mock.calls[0][0];
    mockLoadAll.mockClear();
    handler({ type: 'vacay:invite' });
    expect(mockLoadAll).toHaveBeenCalled();
  });

  // FE-PAGE-VACAY-016: Add next year button calls addYear with max+1
  it('calls addYear with next year when + button at end is clicked', async () => {
    const mockAddYear = vi.fn();
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025, addYear: mockAddYear }) as any);
    const { container } = render(<VacayPage />);
    // The "add next year" button is the last Plus button in the year selector header
    const plusButtons = container.querySelectorAll('button[title]');
    const addNextBtn = Array.from(plusButtons).find(btn => btn.getAttribute('title') && btn.getAttribute('title')!.length > 0 && !btn.getAttribute('title')!.toLowerCase().includes('prev'));
    // Use getAllByTitle or find the second Plus button
    const allPlusButtons = container.querySelectorAll('.p-0\\.5.rounded');
    // Click the rightmost + button (add next year)
    const rightPlusBtn = container.querySelector('button[title]:last-of-type') ??
      Array.from(container.querySelectorAll('button')).find(btn => btn.title && !btn.title.toLowerCase().includes('prev'));
    if (rightPlusBtn) fireEvent.click(rightPlusBtn);
    expect(mockAddYear).toHaveBeenCalledWith(2026);
  });

  // FE-PAGE-VACAY-017: Add prev year button calls addYear with min-1
  it('calls addYear with previous year when + button at start is clicked', async () => {
    const mockAddYear = vi.fn();
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025, addYear: mockAddYear }) as any);
    const { container } = render(<VacayPage />);
    const prevBtn = container.querySelector('button[title]');
    expect(prevBtn).toBeInTheDocument();
    fireEvent.click(prevBtn!);
    expect(mockAddYear).toHaveBeenCalledWith(2023);
  });

  // FE-PAGE-VACAY-018: Year tile click calls setSelectedYear
  it('calls setSelectedYear when a year tile is clicked', async () => {
    const mockSetSelectedYear = vi.fn();
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025, setSelectedYear: mockSetSelectedYear }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getAllByText('2024')[0]).toBeInTheDocument();
    });
    // Click the 2024 year tile (first one in grid)
    fireEvent.click(screen.getAllByText('2024')[0]);
    expect(mockSetSelectedYear).toHaveBeenCalledWith(2024);
  });

  // FE-PAGE-VACAY-019: Legend renders when plan has holidays enabled
  it('renders legend when plan has holidays_enabled', async () => {
    seedStore(useVacayStore, makeVacayState({
      plan: {
        id: 1,
        holidays_enabled: true,
        holiday_calendars: [],
        company_holidays_enabled: false,
        block_weekends: false,
      },
    }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getAllByText(/legend/i)[0]).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-020: Legend renders holiday calendar items
  it('renders legend calendar items from plan', async () => {
    seedStore(useVacayStore, makeVacayState({
      plan: {
        id: 1,
        holidays_enabled: true,
        holiday_calendars: [{ id: 1, region: 'DE', label: 'Germany', color: '#ef4444', sort_order: 0 }],
        company_holidays_enabled: false,
        block_weekends: false,
      },
    }) as any);
    render(<VacayPage />);
    await waitFor(() => {
      expect(screen.getByText('Germany')).toBeInTheDocument();
    });
  });

  // FE-PAGE-VACAY-021: Mobile drawer is named, keyboard reachable, and reversible
  it('moves focus into the mobile year drawer and restores it after Escape', async () => {
    render(<VacayPage />);
    const mobileToggle = screen.getByRole('button', { name: /year open/i });
    mobileToggle.focus();
    fireEvent.click(mobileToggle);

    const drawer = await screen.findByRole('dialog', { name: /year settings/i });
    const close = within(drawer).getByRole('button', { name: /close/i });
    await waitFor(() => expect(close).toHaveFocus());

    fireEvent.keyDown(document, { key: 'Escape' });
    await waitFor(() => {
      expect(screen.queryByRole('dialog', { name: /year settings/i })).not.toBeInTheDocument();
      expect(mobileToggle).toHaveFocus();
    });
  });

  // FE-PAGE-VACAY-022: Delete year modal cancel button closes modal
  it('uses semantic year controls and restores focus after cancelling removal', async () => {
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025 }) as any);
    render(<VacayPage />);
    const yearButton = await screen.findByRole('button', { name: '2024' });
    expect(yearButton).toHaveAttribute('aria-pressed', 'false');
    const trigger = screen.getByRole('button', { name: /remove 2025/i });
    expect(trigger).toHaveClass('min-h-11');
    trigger.focus();
    fireEvent.click(trigger);
    const cancel = await screen.findByRole('button', { name: /cancel/i });
    await waitFor(() => expect(cancel).toHaveFocus());
    fireEvent.click(cancel);
    await waitFor(() => {
      expect(screen.queryByRole('button', { name: /cancel/i })).not.toBeInTheDocument();
      expect(trigger).toHaveFocus();
    });
  });

  // FE-PAGE-VACAY-023: Delete year modal confirm button calls removeYear
  it('calls removeYear when Remove button is clicked in delete modal', async () => {
    const mockRemoveYear = vi.fn().mockResolvedValue(undefined);
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025, removeYear: mockRemoveYear }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    const dialog = await screen.findByRole('alertdialog', { name: /remove 2025/i });
    fireEvent.click(within(dialog).getByRole('button', { name: /remove 2025/i }));
    await waitFor(() => {
      expect(mockRemoveYear).toHaveBeenCalledOnce();
    });
  });

  // FE-PAGE-VACAY-024: Accepted fusion is read-only for whole-year deletion
  it('disables year removal for a fused plan and never opens confirmation', async () => {
    seedStore(useVacayStore, makeVacayState({
      years: [2024, 2025],
      selectedYear: 2025,
      isFused: true,
    }) as any);
    render(<VacayPage />);

    const trigger = await screen.findByRole('button', { name: /remove 2025/i });
    expect(trigger).toBeDisabled();
    expect(screen.getByText(/years cannot be removed while vacation plans are fused/i)).toHaveClass(
      'text-xs',
      'text-content-muted',
    );
    fireEvent.click(trigger);
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
  });

  // FE-PAGE-VACAY-025: Outgoing invitation transition is fail-closed in the UI
  it('disables year removal while an outgoing invitation is pending', async () => {
    seedStore(useVacayStore, makeVacayState({
      years: [2024, 2025],
      selectedYear: 2025,
      pendingInvites: [{ id: 1, user_id: 2 }],
    }) as any);
    render(<VacayPage />);

    const trigger = await screen.findByRole('button', { name: /remove 2025/i });
    expect(trigger).toBeDisabled();
    expect(screen.getByText(/a fusion invitation is pending/i)).toBeVisible();
  });

  // FE-PAGE-VACAY-026: Live fusion invalidates an already-open confirmation
  it('closes an open removal dialog and announces a live solo-to-fused transition', async () => {
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025 }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    await screen.findByRole('alertdialog');

    act(() => {
      useVacayStore.setState({ isFused: true });
    });

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/removal dialog closed.*now fused/i);
    });
  });

  // FE-PAGE-VACAY-026a: Live outgoing invitation also invalidates confirmation
  it('closes an open removal dialog and announces a live solo-to-pending transition', async () => {
    seedStore(useVacayStore, makeVacayState({ years: [2024, 2025], selectedYear: 2025 }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    await screen.findByRole('alertdialog');

    act(() => {
      useVacayStore.setState({ pendingInvites: [{ user_id: 2, username: 'pending-user' }] });
    });

    await waitFor(() => {
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
      expect(screen.getByRole('status')).toHaveTextContent(/removal dialog closed.*invitation is pending/i);
    });
  });

  // FE-PAGE-VACAY-027: Destructive command is single-flight
  it('prevents double submit and blocks closing while removal is pending', async () => {
    let resolveRemoval!: () => void;
    const mockRemoveYear = vi.fn(() => new Promise<void>(resolve => {
      resolveRemoval = resolve;
    }));
    seedStore(useVacayStore, makeVacayState({
      years: [2024, 2025],
      selectedYear: 2025,
      removeYear: mockRemoveYear,
    }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /remove 2025/i });
    const cancel = within(dialog).getByRole('button', { name: /cancel/i });

    fireEvent.click(confirm);
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(mockRemoveYear).toHaveBeenCalledOnce();
      expect(confirm).toBeDisabled();
      expect(confirm).toHaveAttribute('aria-busy', 'true');
      expect(cancel).toBeDisabled();
    });

    await act(async () => {
      resolveRemoval();
    });
    await waitFor(() => expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument());
  });

  // FE-PAGE-VACAY-028: Failed removal remains retryable
  it('explains an uncertain result and succeeds on an explicit retry', async () => {
    const mockRemoveYear = vi.fn()
      .mockRejectedValueOnce(new Error('network down'))
      .mockResolvedValueOnce(undefined);
    seedStore(useVacayStore, makeVacayState({
      years: [2024, 2025],
      selectedYear: 2025,
      removeYear: mockRemoveYear,
    }) as any);
    render(<VacayPage />);
    fireEvent.click(await screen.findByRole('button', { name: /remove 2025/i }));
    const dialog = await screen.findByRole('alertdialog');
    const confirm = within(dialog).getByRole('button', { name: /remove 2025/i });
    fireEvent.click(confirm);

    await waitFor(() => {
      expect(screen.getByRole('alert')).toHaveTextContent(/removal result could not be confirmed/i);
      expect(screen.getByRole('alertdialog')).toBeInTheDocument();
      expect(confirm).toBeEnabled();
    });

    fireEvent.click(confirm);
    await waitFor(() => {
      expect(mockRemoveYear).toHaveBeenCalledTimes(2);
      expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument();
    });
  });
});
