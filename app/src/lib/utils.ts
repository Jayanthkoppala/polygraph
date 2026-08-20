import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Standard shadcn/ui class-merge helper. Used by every component so
 * conditional/override classes (e.g. `className` props) win predictably
 * over the component's own defaults instead of duplicating in the DOM. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
