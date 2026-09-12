"use client";

import { useState } from "react";
import {
  AlignCenterHorizontal,
  AlignCenterVertical,
  AlignEndHorizontal,
  AlignEndVertical,
  AlignStartHorizontal,
  AlignStartVertical,
  BetweenHorizontalEnd,
  BetweenVerticalEnd,
  Group,
  Rows3,
  Ungroup,
} from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Kbd } from "@/components/ui/kbd";
import { Separator } from "@/components/ui/separator";

export type ArrangeAction =
  | "align-left"
  | "align-center-x"
  | "align-right"
  | "align-top"
  | "align-center-y"
  | "align-bottom"
  | "distribute-x"
  | "distribute-centers-x"
  | "distribute-y"
  | "distribute-centers-y"
  | "tidy-auto"
  | "tidy-x"
  | "tidy-y";

export function SelectionArrangeControls({
  canEdit,
  selectedCount,
  selectedIsGroup,
  onGroup,
  onUngroup,
  onArrange,
}: {
  canEdit: boolean;
  selectedCount: number;
  selectedIsGroup: boolean;
  onGroup(): void;
  onUngroup(): void;
  onArrange(
    action: ArrangeAction,
    tidyGap?: number,
    alignToPrimary?: boolean,
  ): void;
}) {
  const [tidyGap, setTidyGap] = useState(0);
  const [alignToPrimary, setAlignToPrimary] = useState(false);
  const arrangeDisabled = !canEdit || selectedCount < 2;
  const distributeDisabled = !canEdit || selectedCount < 3;

  return (
    <div className="border-t" aria-label="组合与排列">
      <div className="flex h-9 items-center justify-between px-3">
        <span className="text-xs font-medium">组合与排列</span>
        <Badge variant="secondary">{selectedCount}</Badge>
      </div>
      <div className="space-y-2 px-2 pb-2">
        <div
          className="grid grid-cols-2 gap-1"
          role="group"
          aria-label="Selection grouping"
        >
          <Button
            variant="outline"
            size="xs"
            disabled={!canEdit || selectedCount === 0}
            title="Group selection (⌘G)"
            onClick={onGroup}
          >
            <Group />
            组合<Kbd className="ml-auto">⌘G</Kbd>
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={!canEdit || !selectedIsGroup}
            title="Ungroup selection (⇧⌘G)"
            onClick={onUngroup}
          >
            <Ungroup />
            取消组合
          </Button>
        </div>

        <Separator />

        <label className="flex items-center gap-2 text-xs text-muted-foreground">
          <Checkbox
            checked={alignToPrimary}
            onCheckedChange={(checked) => setAlignToPrimary(checked === true)}
          />
          以首个图层为基准
        </label>
        <div
          className="grid grid-cols-6 gap-1"
          role="group"
          aria-label="Align selection"
        >
          <ArrangeButton
            label="Align left"
            disabled={arrangeDisabled}
            onClick={() => onArrange("align-left", undefined, alignToPrimary)}
          >
            <AlignStartVertical />
          </ArrangeButton>
          <ArrangeButton
            label="Align horizontal centers"
            disabled={arrangeDisabled}
            onClick={() =>
              onArrange("align-center-x", undefined, alignToPrimary)
            }
          >
            <AlignCenterVertical />
          </ArrangeButton>
          <ArrangeButton
            label="Align right"
            disabled={arrangeDisabled}
            onClick={() => onArrange("align-right", undefined, alignToPrimary)}
          >
            <AlignEndVertical />
          </ArrangeButton>
          <ArrangeButton
            label="Align top"
            disabled={arrangeDisabled}
            onClick={() => onArrange("align-top", undefined, alignToPrimary)}
          >
            <AlignStartHorizontal />
          </ArrangeButton>
          <ArrangeButton
            label="Align vertical centers"
            disabled={arrangeDisabled}
            onClick={() =>
              onArrange("align-center-y", undefined, alignToPrimary)
            }
          >
            <AlignCenterHorizontal />
          </ArrangeButton>
          <ArrangeButton
            label="Align bottom"
            disabled={arrangeDisabled}
            onClick={() => onArrange("align-bottom", undefined, alignToPrimary)}
          >
            <AlignEndHorizontal />
          </ArrangeButton>
        </div>
        <div className="grid grid-cols-2 gap-1">
          <Button
            variant="outline"
            size="xs"
            disabled={distributeDisabled}
            onClick={() => onArrange("distribute-x")}
          >
            <BetweenHorizontalEnd />
            横向分布
          </Button>
          <Button
            variant="outline"
            size="xs"
            disabled={distributeDisabled}
            onClick={() => onArrange("distribute-y")}
          >
            <BetweenVerticalEnd />
            纵向分布
          </Button>
        </div>
        <div className="flex gap-1">
          <Input
            className="h-7 min-w-0 text-xs"
            aria-label="Tidy up gap"
            type="number"
            min="0"
            step="1"
            value={tidyGap}
            onChange={(event) =>
              setTidyGap(Math.max(0, Number(event.target.value) || 0))
            }
          />
          <Button
            className="shrink-0"
            variant="outline"
            size="xs"
            disabled={arrangeDisabled}
            onClick={() => onArrange("tidy-auto", tidyGap)}
          >
            <Rows3 />
            整理
          </Button>
        </div>
      </div>
    </div>
  );
}

function ArrangeButton({
  label,
  disabled,
  onClick,
  children,
}: {
  label: string;
  disabled: boolean;
  onClick: () => void;
  children: React.ReactNode;
}) {
  return (
    <Button
      variant="ghost"
      size="icon-xs"
      disabled={disabled}
      title={label}
      aria-label={label}
      onClick={onClick}
    >
      {children}
    </Button>
  );
}
