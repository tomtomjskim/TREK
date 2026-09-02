import React from 'react';
import { render, screen, fireEvent } from '../../../tests/helpers/render';
import userEvent from '@testing-library/user-event';
import Modal from './Modal';
import CustomSelect from './CustomSelect';
import { lockBodyScroll, resetBodyScrollLock } from '../../utils/bodyScrollLock';

describe('Modal', () => {
  const onClose = vi.fn();

  beforeEach(() => {
    onClose.mockClear();
    resetBodyScrollLock();
    document.body.style.overflow = '';
  });

  it('FE-COMP-MODAL-001: does not render when isOpen is false', () => {
    render(<Modal isOpen={false} onClose={onClose}><p>content</p></Modal>);
    expect(screen.queryByText('content')).toBeNull();
  });

  it('FE-COMP-MODAL-002: renders overlay when isOpen is true', () => {
    render(<Modal isOpen={true} onClose={onClose}><p>content</p></Modal>);
    expect(screen.getByText('content')).toBeTruthy();
  });

  it('FE-COMP-MODAL-003: renders the title prop', () => {
    render(<Modal isOpen={true} onClose={onClose} title="My Modal Title" />);
    expect(screen.getByText('My Modal Title')).toBeTruthy();
  });

  it('FE-COMP-MODAL-004: renders children content', () => {
    render(<Modal isOpen={true} onClose={onClose}><p>Hello World</p></Modal>);
    expect(screen.getByText('Hello World')).toBeTruthy();
  });

  it('FE-COMP-MODAL-005: renders footer prop', () => {
    render(
      <Modal isOpen={true} onClose={onClose} footer={<button>Save</button>}>
        <p>body</p>
      </Modal>
    );
    expect(screen.getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('FE-COMP-MODAL-006: close button calls onClose', async () => {
    const user = userEvent.setup();
    render(<Modal isOpen={true} onClose={onClose} title="T" />);
    // The X button is the only button rendered by Modal itself
    const closeBtn = document.querySelector('button');
    await user.click(closeBtn!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('FE-COMP-MODAL-007: Escape key calls onClose', () => {
    render(<Modal isOpen={true} onClose={onClose} title="T" />);
    fireEvent.keyDown(document, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('FE-COMP-MODAL-008: clicking the backdrop calls onClose', () => {
    render(<Modal isOpen={true} onClose={onClose}><p>inner</p></Modal>);
    const backdrop = document.querySelector('.trek-modal-backdrop') as HTMLElement;
    // Simulate mousedown then click on the backdrop itself
    fireEvent.mouseDown(backdrop, { target: backdrop });
    fireEvent.click(backdrop);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it('FE-COMP-MODAL-009: clicking inside modal content does NOT call onClose', async () => {
    const user = userEvent.setup();
    render(<Modal isOpen={true} onClose={onClose}><p>inner content</p></Modal>);
    await user.click(screen.getByText('inner content'));
    expect(onClose).not.toHaveBeenCalled();
  });

  it('FE-COMP-MODAL-010: close button is hidden when hideCloseButton is true', () => {
    render(<Modal isOpen={true} onClose={onClose} title="T" hideCloseButton={true} />);
    // No button should be present in the modal header
    expect(document.querySelector('button')).toBeNull();
  });

  it('FE-COMP-MODAL-011: sets document.body overflow to hidden when open', () => {
    render(<Modal isOpen={true} onClose={onClose} />);
    expect(document.body.style.overflow).toBe('hidden');
  });

  // #1809: the document is the scroller on a phone, so closing this modal must
  // not unlock the page while another overlay is still holding the lock.
  it('FE-COMP-MODAL-012: unmounting keeps a lock another overlay still holds', () => {
    const otherOverlay = lockBodyScroll();
    const { unmount } = render(<Modal isOpen={true} onClose={onClose} />);
    expect(document.body.style.overflow).toBe('hidden');

    unmount();
    expect(document.body.style.overflow).toBe('hidden');

    otherOverlay();
    expect(document.body.style.overflow).toBe('');
  });

  it('FE-COMP-MODAL-013: focuses the first control and traps Tab navigation', async () => {
    const user = userEvent.setup();
    render(<Modal isOpen={true} onClose={onClose} title="T"><button>Continue</button></Modal>);
    const close = screen.getByRole('button', { name: 'Close' });
    const continueButton = screen.getByRole('button', { name: 'Continue' });
    expect(document.activeElement).toBe(close);
    await user.tab();
    expect(document.activeElement).toBe(continueButton);
    await user.tab();
    expect(document.activeElement).toBe(close);
    await user.tab({ shift: true });
    expect(document.activeElement).toBe(continueButton);
  });

  it('FE-COMP-MODAL-013b: honors an explicit initial focus target', () => {
    const cancelRef = React.createRef<HTMLButtonElement>();
    render(<Modal isOpen={true} onClose={onClose} title="T" initialFocusRef={cancelRef}><button ref={cancelRef}>Cancel</button></Modal>);
    expect(screen.getByRole('button', { name: 'Cancel' })).toHaveFocus();
  });

  it('FE-COMP-MODAL-014: restores focus to the opener after closing', async () => {
    const user = userEvent.setup();
    function Fixture() {
      const [open, setOpen] = React.useState(false);
      return <><button onClick={() => setOpen(true)}>Open</button><Modal isOpen={open} onClose={() => setOpen(false)} title="T" /></>;
    }
    render(<Fixture />);
    const opener = screen.getByRole('button', { name: 'Open' });
    await user.click(opener);
    await user.click(screen.getByRole('button', { name: 'Close' }));
    expect(document.activeElement).toBe(opener);
  });

  it('FE-COMP-MODAL-015: traps focus across a portaled searchable select', async () => {
    const user = userEvent.setup();
    render(
      <Modal isOpen={true} onClose={onClose} title="T">
        <CustomSelect
          value=""
          onChange={() => undefined}
          searchable={true}
          placeholder="Choose"
          options={[
            { value: 'apple', label: 'Apple' },
            { value: 'banana', label: 'Banana' },
            { value: 'cherry', label: 'Cherry' },
          ]}
        />
      </Modal>
    );

    const dialog = screen.getByRole('dialog', { name: 'T' });
    await user.click(screen.getByRole('button', { name: 'Choose' }));
    const search = screen.getByRole('textbox');
    const portalScope = search.closest('[data-trek-modal-focus-scope]');

    expect(search).toHaveFocus();
    expect(portalScope).toHaveAttribute(
      'data-trek-modal-focus-scope',
      dialog.getAttribute('data-trek-modal-focus-scope')
    );
    await user.tab();
    expect(screen.getByRole('button', { name: 'Close' })).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Choose' })).toHaveFocus();
    await user.tab();
    expect(search).toHaveFocus();
  });

  it('FE-COMP-MODAL-015b: selecting a portaled option restores focus inside the modal', async () => {
    const user = userEvent.setup();
    render(
      <Modal isOpen={true} onClose={onClose} title="T">
        <CustomSelect
          value=""
          onChange={() => undefined}
          searchable={true}
          placeholder="Choose"
          options={[{ value: 'apple', label: 'Apple' }]}
        />
        <button type="button">Continue</button>
      </Modal>
    );

    const trigger = screen.getByRole('button', { name: 'Choose' });
    await user.click(trigger);
    await user.click(screen.getByRole('option', { name: 'Apple' }));

    expect(trigger).toHaveFocus();
    await user.tab();
    expect(screen.getByRole('button', { name: 'Continue' })).toHaveFocus();
  });

  it('FE-COMP-MODAL-016: Escape closes only the topmost nested modal', () => {
    const onOuterClose = vi.fn();
    const onInnerClose = vi.fn();

    function Fixture() {
      const [outerOpen, setOuterOpen] = React.useState(true);
      const [innerOpen, setInnerOpen] = React.useState(true);
      return (
        <Modal
          isOpen={outerOpen}
          onClose={() => { onOuterClose(); setOuterOpen(false); }}
          title="Outer"
        >
          <Modal
            isOpen={innerOpen}
            onClose={() => { onInnerClose(); setInnerOpen(false); }}
            title="Inner"
          />
        </Modal>
      );
    }

    render(<Fixture />);
    fireEvent.keyDown(document, { key: 'Escape' });

    expect(onInnerClose).toHaveBeenCalledOnce();
    expect(onOuterClose).not.toHaveBeenCalled();
    expect(screen.queryByRole('dialog', { name: 'Inner' })).not.toBeInTheDocument();
    expect(screen.getByRole('dialog', { name: 'Outer' })).toBeInTheDocument();
  });
});
