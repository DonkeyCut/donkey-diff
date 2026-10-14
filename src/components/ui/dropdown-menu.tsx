import * as Menu from "@radix-ui/react-dropdown-menu";
import { ChevronRight } from "lucide-react";
import { Fragment, type ComponentProps, type ReactNode } from "react";
import { cn } from "@/lib";

// shadcn/ui's Radix dropdown primitives, using the shared theme tokens.
export function DropdownMenuContent({
  className,
  sideOffset = 4,
  ...props
}: ComponentProps<typeof Menu.Content>) {
  return (
    <Menu.Portal>
      <Menu.Content
        data-slot="dropdown-menu-content"
        sideOffset={sideOffset}
        collisionPadding={8}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}
export function DropdownMenuItem({
  className,
  ...props
}: ComponentProps<typeof Menu.Item>) {
  return (
    <Menu.Item
      data-slot="dropdown-menu-item"
      className={cn(
        "relative flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    />
  );
}
export function DropdownMenuSubTrigger({
  className,
  children,
  ...props
}: ComponentProps<typeof Menu.SubTrigger>) {
  return (
    <Menu.SubTrigger
      data-slot="dropdown-menu-sub-trigger"
      className={cn(
        "flex cursor-default items-center gap-2 rounded-sm px-2 py-1.5 text-sm outline-none select-none focus:bg-accent focus:text-accent-foreground data-[disabled]:pointer-events-none data-[disabled]:opacity-50 data-[state=open]:bg-accent data-[state=open]:text-accent-foreground [&_svg]:pointer-events-none [&_svg]:size-4 [&_svg]:shrink-0 [&_svg]:text-muted-foreground",
        className,
      )}
      {...props}
    >
      {children}
      <ChevronRight className="ml-auto" />
    </Menu.SubTrigger>
  );
}
export function DropdownMenuSubContent({
  className,
  ...props
}: ComponentProps<typeof Menu.SubContent>) {
  return (
    <Menu.Portal>
      <Menu.SubContent
        data-slot="dropdown-menu-sub-content"
        collisionPadding={8}
        className={cn(
          "z-50 max-h-(--radix-dropdown-menu-content-available-height) min-w-32 overflow-x-hidden overflow-y-auto rounded-md border border-border bg-popover p-1 text-popover-foreground shadow-md",
          className,
        )}
        {...props}
      />
    </Menu.Portal>
  );
}
export function DropdownMenuSeparator() {
  return (
    <Menu.Separator
      data-slot="dropdown-menu-separator"
      className="-mx-1 my-1 h-px bg-border"
    />
  );
}
type Props = {
  trigger: ReactNode;
  align?: "start" | "center" | "end";
  items: {
    label: string;
    onSelect: () => void;
    icon?: ReactNode;
    separatorBefore?: boolean;
    danger?: boolean;
    disabled?: boolean;
  }[];
};
export function Dropdown({ trigger, items, align = "start" }: Props) {
  return (
    <Menu.Root>
      <Menu.Trigger asChild>{trigger}</Menu.Trigger>
      <DropdownMenuContent align={align} className="min-w-48 max-w-80">
        {items.map((item, i) => (
          <Fragment key={`${item.label}-${i}`}>
            {item.separatorBefore && i > 0 && <DropdownMenuSeparator />}
            <DropdownMenuItem
              disabled={item.disabled}
              onSelect={item.onSelect}
              className={
                item.danger
                  ? "text-red-400 focus:bg-red-500/10 focus:text-red-400"
                  : undefined
              }
            >
              {item.icon}
              <span className="truncate">{item.label}</span>
            </DropdownMenuItem>
          </Fragment>
        ))}
      </DropdownMenuContent>
    </Menu.Root>
  );
}
