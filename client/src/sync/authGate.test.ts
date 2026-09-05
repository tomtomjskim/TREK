import {
  captureAuthGenerationLease,
  isAuthGenerationLeaseValid,
  setAuthed,
} from './authGate'

afterEach(() => {
  setAuthed(false)
})

describe('authGate generation leases', () => {
  it('keeps same-user validation current and invalidates logout or an account switch', () => {
    setAuthed(false)
    setAuthed(true, 41)
    const sameUser = captureAuthGenerationLease()

    setAuthed(true, 41)
    expect(isAuthGenerationLeaseValid(sameUser)).toBe(true)

    setAuthed(true, 42)
    expect(isAuthGenerationLeaseValid(sameUser)).toBe(false)
    const secondUser = captureAuthGenerationLease()

    setAuthed(false)
    expect(isAuthGenerationLeaseValid(secondUser)).toBe(false)
  })
})
