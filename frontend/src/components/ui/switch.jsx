import * as React from "react";
import { Switch as SwitchPrimitive } from "@base-ui/react/switch";
import { cn } from "@/lib/utils";

// Root: primary token when checked (responds to the active color theme),
// slate when unchecked.
function Switch({
  className,
  ...props
}) {
  return (
    <SwitchPrimitive.Root
      data-slot="switch"
      className={cn(
        "inline-flex h-5.5 w-10 shrink-0 cursor-pointer items-center rounded-full border border-slate-300 dark:border-slate-800 transition-colors duration-200",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-primary focus-visible:ring-offset-2",
        "disabled:cursor-not-allowed disabled:opacity-50",
        "data-[checked]:bg-primary data-[checked]:border-primary data-[state=checked]:bg-primary data-[state=checked]:border-primary",
        "data-[unchecked]:bg-slate-300 dark:data-[unchecked]:bg-slate-700 data-[state=unchecked]:bg-slate-300 dark:data-[state=unchecked]:bg-slate-700",
        className
      )}
      {...props}
    >
      <SwitchPrimitive.Thumb
        data-slot="switch-thumb"
        style={{ backgroundColor: '#ffffff' }}
        className={cn(
          "pointer-events-none block h-4.5 w-4.5 rounded-full shadow-md ring-0 transition-transform duration-200",
          "data-[checked]:translate-x-4.5 data-[state=checked]:translate-x-4.5 data-[unchecked]:translate-x-0.5 data-[state=unchecked]:translate-x-0.5"
        )}
      />
    </SwitchPrimitive.Root>
  );
}
export { Switch };
