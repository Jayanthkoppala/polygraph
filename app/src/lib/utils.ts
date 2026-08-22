import { clsx, type ClassValue } from 'clsx';
import { twMerge } from 'tailwind-merge';

/** Standard shadcn/ui class merge: a caller's `className` wins over a component's
 *  own defaults instead of both landing in the DOM. */
export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}
