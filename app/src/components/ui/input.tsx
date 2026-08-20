import * as React from "react"

import { cn } from "@/lib/utils"

function Input({ className, type, ...props }: React.ComponentProps<"input">) {
  return (
    <input
      type={type}
      data-slot="input"
      className={cn(
        "h-9 w-full min-w-0 rounded-sm border border-[var(--color-line)] bg-[var(--color-sunken)] px-3 py-1 text-sm text-[#EDEDED] shadow-xs transition-[color,box-shadow] outline-none selection:bg-[#EDEDED] selection:text-[#131209] file:inline-flex file:h-7 file:border-0 file:bg-transparent file:text-sm file:font-medium file:text-[#EDEDED] placeholder:text-[#8B949E] disabled:pointer-events-none disabled:cursor-not-allowed disabled:opacity-40",
        "focus-visible:border-[#EDEDED] focus-visible:ring-[3px] focus-visible:ring-[#EDEDED]/50",
        "aria-invalid:border-[var(--color-verdict-shape)] aria-invalid:ring-[var(--color-verdict-shape)]/20",
        className
      )}
      {...props}
    />
  )
}

export { Input }
