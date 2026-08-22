import * as React from "react"
import { cva, type VariantProps } from "class-variance-authority"
import { Slot } from "radix-ui"

import { cn } from "@/lib/utils"

const buttonVariants = cva(
  "inline-flex shrink-0 items-center justify-center gap-2 rounded-sm text-sm font-medium whitespace-nowrap transition-[background-color,border-color,color,box-shadow,transform] duration-150 outline-none focus-visible:border-[#EDEDED] focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50 disabled:pointer-events-none disabled:opacity-40 aria-invalid:border-[var(--color-verdict-shape)] aria-invalid:ring-[var(--color-verdict-shape)]/20 [&_svg]:pointer-events-none [&_svg]:shrink-0 [&_svg:not([class*='size-'])]:size-4",
  {
    variants: {
      variant: {
        default:
          "bg-[#EDEDED] text-[#131209] hover:bg-[#EDEDED]/90 disabled:bg-[#1F1F1F] disabled:text-[#9B9B9B] disabled:opacity-100",
        destructive:
          "bg-[var(--color-verdict-shape)] text-[#131209] hover:bg-[var(--color-verdict-shape)]/90 focus-visible:ring-[var(--color-verdict-shape)]/20",
        outline:
          "border border-[var(--color-line)] bg-transparent shadow-xs hover:bg-[var(--color-raised)] hover:text-[#EDEDED] text-[#EDEDED]",
        secondary:
          "bg-[var(--color-raised)] text-[#EDEDED] hover:bg-[var(--color-raised)]/80",
        ghost:
          "hover:bg-[var(--color-raised)] hover:text-[#EDEDED] text-[#EDEDED]",
        link: "text-[#EDEDED] underline-offset-4 hover:underline",
      },
      size: {
        default: "h-9 px-4 py-2 has-[>svg]:px-3",
        xs: "h-6 gap-1 rounded-md px-2 text-xs has-[>svg]:px-1.5 [&_svg:not([class*='size-'])]:size-3",
        sm: "h-8 gap-1.5 rounded-md px-3 has-[>svg]:px-2.5",
        lg: "h-10 rounded-md px-6 has-[>svg]:px-4",
        icon: "size-9",
        "icon-xs": "size-6 rounded-md [&_svg:not([class*='size-'])]:size-3",
        "icon-sm": "size-8",
        "icon-lg": "size-10",
      },
    },
    defaultVariants: {
      variant: "default",
      size: "default",
    },
  }
)

function Button({
  className,
  variant = "default",
  size = "default",
  asChild = false,
  ...props
}: React.ComponentProps<"button"> &
  VariantProps<typeof buttonVariants> & {
    asChild?: boolean
  }) {
  const Comp = asChild ? Slot.Root : "button"

  return (
    <Comp
      data-slot="button"
      data-variant={variant}
      data-size={size}
      className={cn(buttonVariants({ variant, size, className }))}
      {...props}
    />
  )
}

export { Button, buttonVariants }
