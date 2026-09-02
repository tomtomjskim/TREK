import { render, screen, fireEvent } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import CustomSelect from './CustomSelect';

const OPTIONS = [
  { value: 'apple', label: 'Apple' },
  { value: 'banana', label: 'Banana' },
  { value: 'cherry', label: 'Cherry' },
];

describe('CustomSelect', () => {
  const onChange = vi.fn();

  beforeEach(() => {
    onChange.mockClear();
  });

  it('FE-COMP-SELECT-001: renders placeholder when no value is selected', () => {
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} placeholder="Pick a fruit" />);
    expect(screen.getByText('Pick a fruit')).toBeTruthy();
  });

  it('FE-COMP-SELECT-002: renders the selected option label', () => {
    render(<CustomSelect value="banana" onChange={onChange} options={OPTIONS} placeholder="Pick" />);
    expect(screen.getByText('Banana')).toBeTruthy();
  });

  it('FE-COMP-SELECT-003: clicking trigger opens the dropdown', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    // All options should now be visible in the portal
    expect(screen.getByText('Apple')).toBeTruthy();
    expect(screen.getByText('Banana')).toBeTruthy();
    expect(screen.getByText('Cherry')).toBeTruthy();
  });

  it('FE-COMP-SELECT-004: options are displayed in the dropdown', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('button'));
    expect(screen.getAllByRole('option')).toHaveLength(3);
  });

  it('FE-COMP-SELECT-005: clicking an option calls onChange with correct value', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('button')); // open
    // Options in dropdown are also buttons
    const optionBtns = screen.getAllByRole('option');
    // Find the Cherry option button (not the trigger which shows placeholder)
    const cherryBtn = optionBtns.find(b => b.textContent?.includes('Cherry'));
    await user.click(cherryBtn!);
    expect(onChange).toHaveBeenCalledWith('cherry');
  });

  it('FE-COMP-SELECT-006: clicking an option closes the dropdown', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('button')); // open
    const optionBtns = screen.getAllByRole('option');
    const appleBtn = optionBtns.find(b => b.textContent?.includes('Apple'));
    await user.click(appleBtn!);
    // After selection, only the trigger button remains in DOM
    expect(screen.getAllByRole('button')).toHaveLength(1);
  });

  it('FE-COMP-SELECT-007: searchable mode filters options by typed text', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} searchable={true} />);
    await user.click(screen.getByRole('button')); // open

    const searchInput = screen.getByPlaceholderText('...');
    await user.type(searchInput, 'ban');

    // Only Banana should remain, Apple and Cherry should be filtered out
    expect(screen.getByText('Banana')).toBeTruthy();
    expect(screen.queryByText('Apple')).toBeNull();
    expect(screen.queryByText('Cherry')).toBeNull();
  });

  // #2078 — the panel is portaled to document.body and positioned fixed, so its
  // scroll chain runs to the viewport, not to the sheet it visually sits in. On a
  // phone a flick past either end of the list moved the page instead.
  it('FE-COMP-SELECT-009: the option list keeps its scroll to itself', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('button'));

    const list = screen.getByText('Apple').closest('div[style*="overflow"]') as HTMLElement;
    expect(list.style.overscrollBehavior).toBe('contain');
  });

  it('FE-COMP-SELECT-010: it is still a bounded scroller, not a contained page', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} />);
    await user.click(screen.getByRole('button'));

    // Guards the other half: containment without a height cap would just make the
    // panel grow off screen.
    const list = screen.getByText('Apple').closest('div[style*="overflow"]') as HTMLElement;
    expect(list.style.overflowY).toBe('auto');
    expect(Number.parseInt(list.style.maxHeight, 10)).toBeGreaterThan(0);
  });

  it('FE-COMP-SELECT-008: disabled state prevents the dropdown from opening', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} disabled={true} placeholder="Pick" />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    // Dropdown should not be in the DOM — options remain hidden
    expect(screen.queryByText('Apple')).toBeNull();
  });

  it('FE-COMP-SELECT-011: exposes listbox semantics and selection state', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="banana" onChange={onChange} options={OPTIONS} placeholder="Pick" />);
    const trigger = screen.getByRole('button');
    expect(trigger).toHaveAttribute('aria-haspopup', 'listbox');
    expect(trigger).toHaveAttribute('aria-expanded', 'false');
    await user.click(trigger);
    const listbox = screen.getByRole('listbox');
    expect(trigger).toHaveAttribute('aria-controls', listbox.id);
    expect(screen.getByRole('option', { name: 'Banana' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('option', { name: 'Apple' })).toHaveAttribute('aria-selected', 'false');
  });

  it('FE-COMP-SELECT-012: moves through options and selects with keyboard', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="apple" onChange={onChange} options={OPTIONS} />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    await user.keyboard('{ArrowDown}{ArrowDown}{Enter}');
    expect(onChange).toHaveBeenCalledWith('cherry');
    expect(trigger).toHaveFocus();
  });

  it('FE-COMP-SELECT-013: supports Home/End and skips disabled options', async () => {
    const user = userEvent.setup();
    const options = [
      { value: 'one', label: 'One' },
      { value: 'two', label: 'Two', disabled: true },
      { value: 'three', label: 'Three' },
    ];
    render(<CustomSelect value="one" onChange={onChange} options={options} />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    expect(screen.getByRole('option', { name: 'Two' })).toBeDisabled();
    await user.keyboard('{ArrowDown}{End}{Enter}');
    expect(onChange).toHaveBeenCalledWith('three');
    await user.click(trigger);
    await user.keyboard('{Home}{Enter}');
    expect(onChange).toHaveBeenLastCalledWith('one');
  });

  it('FE-COMP-SELECT-014: Escape closes and restores trigger focus, including searchable mode', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} searchable />);
    const trigger = screen.getByRole('button');
    await user.click(trigger);
    expect(screen.getByPlaceholderText('...')).toHaveFocus();
    await user.keyboard('{Escape}');
    expect(screen.queryByRole('listbox')).toBeNull();
    expect(trigger).toHaveFocus();
  });

  it('FE-COMP-SELECT-015: keeps Space and Home/End available for search editing', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const searchInput = screen.getByRole('textbox', { name: 'Search options' });
    await user.type(searchInput, 'a b');
    expect(searchInput).toHaveValue('a b');
    await user.keyboard('{Home}X{End}Y');
    expect(searchInput).toHaveValue('Xa bY');
    expect(screen.getByRole('listbox')).toBeInTheDocument();
  });

  it('FE-COMP-SELECT-016: moves one searchable option per Arrow key', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="" onChange={onChange} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const listbox = screen.getByRole('listbox');
    const searchInput = screen.getByRole('textbox', { name: 'Search options' });
    await user.type(searchInput, 'a');
    await user.keyboard('{ArrowDown}');
    expect(listbox).toHaveAttribute('aria-activedescendant', expect.stringContaining('option-banana'));
  });

  it('FE-COMP-SELECT-017: Enter selects the first matching result after search narrows', async () => {
    const user = userEvent.setup();
    render(<CustomSelect value="banana" onChange={onChange} options={OPTIONS} searchable />);
    await user.click(screen.getByRole('button'));
    const searchInput = screen.getByRole('textbox', { name: 'Search options' });

    await user.type(searchInput, 'app');

    const listbox = screen.getByRole('listbox');
    expect(listbox).toHaveAttribute('aria-activedescendant', expect.stringContaining('option-apple'));
    await user.keyboard('{Enter}');
    expect(onChange).toHaveBeenCalledWith('apple');
  });
});
