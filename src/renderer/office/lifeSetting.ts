/**
 * Whether the office's simulated life is switched on. It is on unless the person turned it off, and
 * remembered on this computer only: a convenience of this window, never something the app depends
 * on, so a store that cannot be read or written just leaves it on.
 */

const KEY = 'shokuba.officeLife'

export function readLifeSetting(storage: Pick<Storage, 'getItem'> | undefined): boolean {
  try {
    // Anything but a clear "off" leaves it on, so a damaged value never silently hides the office's life.
    return storage?.getItem(KEY) !== 'off'
  } catch {
    return true
  }
}

export function writeLifeSetting(storage: Pick<Storage, 'setItem'> | undefined, on: boolean): void {
  try {
    storage?.setItem(KEY, on ? 'on' : 'off')
  } catch {
    /* it lasts until the window closes instead */
  }
}
