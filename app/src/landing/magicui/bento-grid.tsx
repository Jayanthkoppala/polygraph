/**
 * Magic UI `bento-grid` (registry:ui, pulled from the Magic UI registry via
 * MCP `getRegistryItem("bento-grid")`), corrected per ui-system.md §3.1's
 * convention: the component's real structure — a spanning grid of feature
 * cards with a hover-lifted content block — kept intact, with the shipped
 * lines that break the design law replaced and named.
 *
 * Corrections to the shipped source:
 *  - `rounded-xl` → `rounded-2xl` (§1.7: card radius is 16).
 *  - The shipped light/dark box-shadow stacks (including
 *    `dark:[box-shadow:0_-20px_80px_-20px_#ffffff1f_inset]`, a 20px interior
 *    glow — a wash on the surface) → §1.8's elevation system: resting cards
 *    carry a border and no shadow, hover carries --shadow-e2's 1px inset
 *    top hairline + tight drop.
 *  - `bg-background`/`text-neutral-*` theme colors → the token surfaces and
 *    text ramp (#1F1F1F card on either ground, #EDEDED / #B4B4B4 text).
 *  - `duration-300` + implicit `ease-in-out` → --dur-base + --ease-fluid
 *    (§1.9 bans `ease-in-out`).
 *  - `@radix-ui/react-icons` ArrowRightIcon + shadcn Button →
 *    `@phosphor-icons/react` ArrowRight and a plain anchor: Phosphor is the
 *    product's only icon set (§2.4) and radix-icons would be a new
 *    dependency for one arrow.
 *  - 48px icon → 20px, §2.4's panel size.
 *  - `href`/`cta` made optional — a fact card is not a link, and a fake
 *    "Learn more" pointing nowhere is a dead link (§7 review checklist).
 *  - `gap-4`/`p-4` → `gap-2`/`p-3` (§1.6: 8px between cards, 12px padding).
 *  - `auto-rows-[22rem]` dropped: an arbitrary value, and fixed 22rem rows
 *    force either empty air or clipped copy at this content density.
 */
import { type ComponentPropsWithoutRef, type ReactNode } from 'react';
import { ArrowRight, type Icon } from '@phosphor-icons/react';
import { cn } from '@/lib/utils';

interface BentoGridProps extends ComponentPropsWithoutRef<'div'> {
  children: ReactNode;
  className?: string;
}

interface BentoCardProps extends ComponentPropsWithoutRef<'div'> {
  name: string;
  className?: string;
  background?: ReactNode;
  Icon: Icon;
  description: ReactNode;
  href?: string;
  cta?: string;
}

const BentoGrid = ({ children, className, ...props }: BentoGridProps) => {
  return (
    <div className={cn('grid w-full grid-cols-1 gap-2 lg:grid-cols-3', className)} {...props}>
      {children}
    </div>
  );
};

const BentoCard = ({ name, className, background, Icon, description, href, cta, ...props }: BentoCardProps) => (
  <div
    key={name}
    className={cn(
      'group relative flex transform-gpu flex-col justify-between overflow-hidden rounded-2xl',
      'border border-[#272727] bg-[#1F1F1F]',
      'transition-all duration-[260ms] ease-[var(--ease-fluid)]',
      'hover:border-[#313131] hover:shadow-[var(--shadow-e2)]',
      className,
    )}
    {...props}
  >
    {background !== undefined && <div>{background}</div>}
    <div className="p-3">
      <div
        className={cn(
          'pointer-events-none flex transform-gpu flex-col gap-2 transition-all duration-[260ms] ease-[var(--ease-fluid)]',
          href && cta && 'lg:group-hover:-translate-y-10',
        )}
      >
        <Icon size={20} weight="regular" aria-hidden className="text-[#9B9B9B]" />
        <h3 className="text-base font-semibold text-[#EDEDED]">{name}</h3>
        <p className="text-pretty text-sm text-[#B4B4B4]">{description}</p>
      </div>

      {href && cta && (
        <div className="flex w-full flex-row items-center pt-2 lg:hidden">
          <a href={href} className="flex items-center gap-1 text-sm font-semibold text-[#EDEDED]">
            {cta}
            <ArrowRight size={16} weight="regular" aria-hidden />
          </a>
        </div>
      )}
    </div>

    {href && cta && (
      <div
        className={cn(
          'pointer-events-none absolute bottom-0 hidden w-full translate-y-10 transform-gpu flex-row items-center p-3 opacity-0',
          'transition-all duration-[260ms] ease-[var(--ease-fluid)] group-hover:translate-y-0 group-hover:opacity-100 lg:flex',
        )}
      >
        <a href={href} className="pointer-events-auto flex items-center gap-1 text-sm font-semibold text-[#EDEDED]">
          {cta}
          <ArrowRight size={16} weight="regular" aria-hidden />
        </a>
      </div>
    )}
  </div>
);

export { BentoCard, BentoGrid };
