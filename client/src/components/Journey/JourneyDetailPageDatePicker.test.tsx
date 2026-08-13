import userEvent from '@testing-library/user-event';
import { render, screen } from '../../../tests/helpers/render';
import { resetAllStores } from '../../../tests/helpers/store';
import { useSettingsStore } from '../../store/settingsStore';
import { DatePicker } from './JourneyDetailPageDatePicker';

describe('Journey DatePicker calendar week start', () => {
  beforeEach(() => {
    resetAllStores();
  });

  it('FE-COMP-JOURNEY-DATEPICKER-001: defaults to Monday-first when the preference is unset', async () => {
    const user = userEvent.setup();
    render(<DatePicker value="2026-03-01" onChange={vi.fn()} />);

    await user.click(screen.getAllByRole('button')[0]);

    expect(screen.getByTestId('journey-date-picker-weekdays').textContent).toBe('MoTuWeThFrSaSu');
    expect(screen.getByTestId('journey-date-picker-days').children[6]?.textContent).toBe('1');
  });

  it('FE-COMP-JOURNEY-DATEPICKER-002: applies a stored Sunday-first preference', async () => {
    const user = userEvent.setup();
    useSettingsStore.setState({
      settings: { ...useSettingsStore.getState().settings, calendar_week_start: 0 },
    });
    render(<DatePicker value="2026-03-01" onChange={vi.fn()} />);

    await user.click(screen.getAllByRole('button')[0]);

    expect(screen.getByTestId('journey-date-picker-weekdays').textContent).toBe('SuMoTuWeThFrSa');
    expect(screen.getByTestId('journey-date-picker-days').firstElementChild?.textContent).toBe('1');
  });
});
