/*---------------------------------------------------------
 * Copyright (C) Microsoft Corporation. All rights reserved.
 *--------------------------------------------------------*/

import { Fragment, FunctionComponent, h } from 'preact';
import { useCallback, useContext, useEffect, useMemo, useRef, useState } from 'preact/hooks';
import * as GoToFileIcon from 'vscode-codicons/src/icons/go-to-file.svg';
import { binarySearch } from 'vscode-js-profile-core/out/esm/array';
import { Icon } from 'vscode-js-profile-core/out/esm/client/icons';
import { MiddleOut } from 'vscode-js-profile-core/out/esm/client/middleOutCompression';
import { useCssVariables } from 'vscode-js-profile-core/out/esm/client/useCssVariables';
import { usePersistedState } from 'vscode-js-profile-core/out/esm/client/usePersistedState';
import { useWindowSize } from 'vscode-js-profile-core/out/esm/client/useWindowSize';
import { classes } from 'vscode-js-profile-core/out/esm/client/util';
import { IVscodeApi, VsCodeApi } from 'vscode-js-profile-core/out/esm/client/vscodeApi';
import { decimalFormat, getLocationText } from 'vscode-js-profile-core/out/esm/cpu/display';
import { Category, ILocation, IProfileModel } from 'vscode-js-profile-core/out/esm/cpu/model';
import { IOpenDocumentMessage } from 'vscode-js-profile-core/out/esm/cpu/types';
import styles from './flame-graph.css';
import { IColumn, IColumnLocation } from './stacks';
import { TextCache } from './textCache';
import { setupGl } from './webgl/boxes';

export const enum Constants {
  BoxHeight = 20,
  TextColor = '#fff',
  BoxColor = '#000',
  TimelineHeight = 22,
  TimelineLabelSpacing = 200,
  MinWindow = 0.005,
  ExtraYBuffer = 300,
  DefaultStackLimit = 7,
}

const pickColor = (location: IColumnLocation): number => {
  if (location.category === Category.System) {
    return -1;
  }

  const hash = location.graphId * 5381; // djb2's prime, just some bogus stuff
  return hash & 0xff;
};

export interface IBox {
  column: number;
  row: number;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
  color: number;
  level: number;
  text: string;
  category: number;
  loc: IColumnLocation;
}

const buildBoxes = (columns: ReadonlyArray<IColumn>, filtered: ReadonlyArray<number>) => {
  const boxes: Map<number, IBox> = new Map();
  let maxY = 0;
  for (let x = 0; x < columns.length; x++) {
    const col = columns[x];
    const highlightY = filtered[x];
    for (let y = 0; y < col.rows.length; y++) {
      const loc = col.rows[y];
      if (typeof loc === 'number') {
        // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
        getBoxInRowColumn(columns, boxes, x, y)!.x2 = col.x2;
      } else {
        const y1 = Constants.BoxHeight * y + Constants.TimelineHeight;
        const y2 = y1 + Constants.BoxHeight;
        boxes.set(loc.graphId, {
          column: x,
          row: y,
          x1: col.x1,
          x2: col.x2,
          y1,
          y2,
          level: y,
          text: loc.callFrame.functionName,
          color: pickColor(loc),
          category: y <= highlightY ? loc.category : Category.Deemphasized,
          loc,
        });

        maxY = Math.max(y2, maxY);
      }
    }
  }

  return {
    boxById: boxes,
    maxY,
  };
};

export interface IBounds {
  minX: number;
  maxX: number;
  y: number;
  level: number;
}

const enum LockBound {
  None = 0,
  Y = 1 << 0,
  MinX = 1 << 1,
  MaxX = 1 << 2,
}

interface IDrag {
  timestamp: number;
  pageXOrigin: number;
  pageYOrigin: number;
  original: IBounds;
  xPerPixel: number;
  lock: LockBound;
}

const enum HighlightSource {
  Hover,
  Keyboard,
}

const clamp = (min: number, v: number, max: number) => Math.max(Math.min(v, max), min);

const timelineFormat = new Intl.NumberFormat(undefined, {
  maximumSignificantDigits: 3,
  minimumSignificantDigits: 3,
});

const dpr = window.devicePixelRatio || 1;

const getBoxInRowColumn = (
  columns: ReadonlyArray<IColumn>,
  boxes: ReadonlyMap<number, IBox>,
  column: number,
  row: number,
) => {
  let candidate = columns[column]?.rows[row];
  if (typeof candidate === 'number') {
    candidate = columns[candidate].rows[row];
  }

  return candidate !== undefined
    ? boxes.get((candidate as { graphId: number }).graphId)
    : undefined;
};

interface ISerializedState {
  focusedId?: number;
  bounds?: IBounds;
}

export interface ICanvasSize {
  width: number;
  height: number;
}

/**
 * Gets the floating point precision threshold for calculating positions and
 * intersections within the given set of bounds.
 */
const epsilon = (bounds: IBounds) => (bounds.maxX - bounds.minX) / 100_000;

export const FlameGraph: FunctionComponent<{
  columns: ReadonlyArray<IColumn>;
  filtered: ReadonlyArray<number>;
  model: IProfileModel;
}> = ({ columns, model, filtered }) => {
  const vscode = useContext(VsCodeApi) as IVscodeApi<ISerializedState>;

  const webCanvas = useRef<HTMLCanvasElement>();
  const webContext = useMemo(() => webCanvas.current?.getContext('2d'), [webCanvas.current]);
  const glCanvas = useRef<HTMLCanvasElement>();

  const windowSize = useWindowSize();
  const [canvasSize, setCanvasSize] = useState<ICanvasSize>({ width: 100, height: 100 });
  const [hovered, setHovered] = useState<{ box: IBox; src: HighlightSource } | undefined>(
    undefined,
  );
  const [drag, setDrag] = useState<IDrag | undefined>(undefined);
  const [showInfo, setShowInfo] = useState(false);
  const cssVariables = useCssVariables();

  const rawBoxes = useMemo(() => buildBoxes(columns, filtered), [columns, filtered]);
  const clampY = Math.max(0, rawBoxes.maxY - canvasSize.height + Constants.ExtraYBuffer);
  const [focused, setFocused] = useState<IBox | undefined>(undefined);
  const [bounds, setBounds] = usePersistedState<IBounds>('bounds', {
    minX: 0,
    maxX: 1,
    y: 0,
    level: 0,
  });

  const gl = useMemo(
    () =>
      glCanvas.current &&
      setupGl({
        canvas: glCanvas.current,
        focusColor: cssVariables.focusBorder,
        primaryColor: cssVariables['charts-red'],
        boxes: [...rawBoxes.boxById.values()],
        scale: dpr,
      }),
    [glCanvas.current],
  );
  useEffect(() => gl?.setBoxes([...rawBoxes.boxById.values()]), [rawBoxes]);
  useEffect(() => gl?.setBounds(bounds, canvasSize, dpr), [bounds, canvasSize]);
  useEffect(() => gl?.setFocusColor(cssVariables.focusBorder), [cssVariables.focusBorder]);
  useEffect(() => gl?.setPrimaryColor(cssVariables['charts-red']), [cssVariables['charts-red']]);
  useEffect(() => gl?.setFocused(focused?.loc.graphId), [focused]);
  useEffect(() => gl?.setHovered(hovered?.box.loc.graphId), [hovered]);

  useEffect(() => {
    if (focused) {
      setShowInfo(true);
    }
  }, [focused]);

  const openBox = useCallback(
    (box: IBox, evt: { altKey: boolean }) => {
      const src = box.loc.src;
      if (!src?.source.path) {
        return;
      }

      vscode.postMessage<IOpenDocumentMessage>({
        type: 'openDocument',
        location: src,
        callFrame: box.loc.callFrame,
        toSide: evt.altKey,
      });
    },
    [vscode],
  );

  const textCache = useMemo(
    () =>
      new TextCache(
        `${Constants.BoxHeight / 1.9}px ${cssVariables['editor-font-family']}`,
        Constants.TextColor,
        dpr,
      ),
    [cssVariables],
  );

  useEffect(() => {
    if (webContext) {
      webContext.textBaseline = 'middle';
      webContext.scale(dpr, dpr);
    }
  }, [webContext, canvasSize]);

  // Re-render box labels when data changes
  useEffect(() => {
    if (!webContext) {
      return;
    }

    webContext.clearRect(0, Constants.TimelineHeight, canvasSize.width, canvasSize.height);
    webContext.save();
    webContext.beginPath();
    webContext.rect(0, Constants.TimelineHeight, canvasSize.width, canvasSize.height);

    for (const box of rawBoxes.boxById.values()) {
      if (box.y2 < bounds.y) {
        continue;
      }

      if (box.y1 > bounds.y + canvasSize.height) {
        continue;
      }

      const xScale = canvasSize.width / (bounds.maxX - bounds.minX);
      const x1 = Math.max(0, (box.x1 - bounds.minX) * xScale);
      if (x1 > canvasSize.width) {
        continue;
      }

      const x2 = (box.x2 - bounds.minX) * xScale;
      if (x2 < 0) {
        continue;
      }

      const width = x2 - x1;
      if (width < 10) {
        continue;
      }

      textCache.drawText(
        webContext,
        box.text,
        x1 + 3,
        box.y1 - bounds.y + 3,
        width - 6,
        Constants.BoxHeight,
      );
    }

    webContext.clip();
    webContext.restore();
  }, [webContext, bounds, rawBoxes, canvasSize, cssVariables]);

  // Re-render the zoom indicator when bounds change
  useEffect(() => {
    if (!webContext) {
      return;
    }

    webContext.clearRect(0, 0, webContext.canvas.width, Constants.TimelineHeight);
    webContext.fillStyle = cssVariables['editor-foreground'];
    webContext.font = webContext.textAlign = 'right';
    webContext.strokeStyle = cssVariables['editorRuler-foreground'];
    webContext.lineWidth = 1 / dpr;

    const labels = Math.round(canvasSize.width / Constants.TimelineLabelSpacing);
    const spacing = canvasSize.width / labels;

    const timeRange = model.duration * (bounds.maxX - bounds.minX);
    const timeStart = model.duration * bounds.minX;

    webContext.beginPath();
    for (let i = 1; i <= labels; i++) {
      const time = (i / labels) * timeRange + timeStart;
      const x = i * spacing;
      webContext.fillText(
        `${timelineFormat.format(time / 1000)}ms`,
        x - 3,
        Constants.TimelineHeight / 2,
      );
      webContext.moveTo(x, 0);
      webContext.lineTo(x, Constants.TimelineHeight);
    }

    webContext.stroke();
    webContext.textAlign = 'left';
  }, [webContext, model, canvasSize, bounds, cssVariables]);

  // Update the canvas size when the window size changes, and on initial render
  useEffect(() => {
    if (!webCanvas.current || !glCanvas.current) {
      return;
    }

    const { width, height } = (webCanvas.current
      .parentElement as HTMLElement).getBoundingClientRect();
    if (width === canvasSize.width && height === canvasSize.height) {
      return;
    }

    for (const canvas of [webCanvas.current, glCanvas.current]) {
      canvas.style.width = `${width}px`;
      canvas.width = width * dpr;
      canvas.style.height = `${height}px`;
      canvas.height = height * dpr;
    }

    setCanvasSize({ width, height });
  }, [windowSize]);

  // Callback that zoomes into the given box.
  const zoomToBox = useCallback(
    (box: IBox) => {
      // eslint-disable-next-line @typescript-eslint/no-non-null-assertion
      setBounds({
        minX: box.x1,
        maxX: box.x2,
        y: clamp(0, box.y1 > bounds.y + canvasSize.height ? box.y1 : bounds.y, clampY),
        level: box.level,
      });
      setFocused(box);
    },
    [clampY, canvasSize.height, bounds],
  );

  // Key event handler, deals with focus navigation and escape/enter
  const onKeyDown = useCallback(
    (evt: KeyboardEvent) => {
      switch (evt.key) {
        case 'Escape':
          // If there's a tooltip open, close that on first escape
          return hovered?.src === HighlightSource.Keyboard
            ? setHovered(undefined)
            : showInfo
            ? setShowInfo(false)
            : setBounds({ minX: 0, maxX: 1, y: 0, level: 0 });
        case 'Enter':
          if ((evt.metaKey || evt.ctrlKey) && hovered) {
            return openBox(hovered.box, evt);
          }

          return focused && zoomToBox(focused);
        case 'Space':
          return focused && zoomToBox(focused);
        default:
        // fall through
      }

      if (!focused) {
        return;
      }

      let nextFocus: IBox | false | undefined;
      switch (evt.key) {
        case 'ArrowRight':
          for (
            let x = focused.column + 1;
            x < columns.length && columns[x].x1 + epsilon(bounds) < bounds.maxX;
            x++
          ) {
            const box = getBoxInRowColumn(columns, rawBoxes.boxById, x, focused.row);
            if (box && box !== focused) {
              nextFocus = box;
              break;
            }
          }
          break;
        case 'ArrowLeft':
          for (
            let x = focused.column - 1;
            x >= 0 && columns[x].x2 - epsilon(bounds) > bounds.minX;
            x--
          ) {
            const box = getBoxInRowColumn(columns, rawBoxes.boxById, x, focused.row);
            if (box && box !== focused) {
              nextFocus = box;
              break;
            }
          }
          break;
        case 'ArrowUp':
          nextFocus = getBoxInRowColumn(columns, rawBoxes.boxById, focused.column, focused.row - 1);
          break;
        case 'ArrowDown':
          {
            let x = focused.column;
            do {
              nextFocus = getBoxInRowColumn(columns, rawBoxes.boxById, x, focused.row + 1);
            } while (!nextFocus && columns[++x]?.rows[focused.row] === focused.column);
          }
          break;
        default:
          break;
      }

      if (nextFocus) {
        setFocused(nextFocus);
        setHovered({ box: nextFocus, src: HighlightSource.Keyboard });
      }
    },
    [zoomToBox, focused, hovered, rawBoxes, showInfo],
  );

  // Keyboard events
  useEffect(() => {
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
  }, [onKeyDown]);

  const getBoxUnderCursor = useCallback(
    (evt: MouseEvent) => {
      if (!webCanvas.current) {
        return;
      }

      const { top, left, width } = webCanvas.current.getBoundingClientRect();
      const fromTop = evt.pageY - top;
      const fromLeft = evt.pageX - left;
      if (fromTop < Constants.TimelineHeight) {
        return;
      }

      const x = (fromLeft / width) * (bounds.maxX - bounds.minX) + bounds.minX;
      const col = Math.abs(binarySearch(columns, c => c.x2 - x)) - 1;
      if (!columns[col] || columns[col].x1 > x) {
        return;
      }

      const row = Math.floor((fromTop + bounds.y - Constants.TimelineHeight) / Constants.BoxHeight);
      return getBoxInRowColumn(columns, rawBoxes.boxById, col, row);
    },
    [webCanvas, bounds, columns, rawBoxes],
  );

  // Listen for drag events on the window when it's running
  useEffect(() => {
    if (!drag) {
      return;
    }

    const { original, pageXOrigin, xPerPixel, pageYOrigin, lock } = drag;
    const onMove = (evt: MouseEvent) => {
      const range = original.maxX - original.minX;
      let minX: number;
      let maxX: number;
      if (!(lock & LockBound.MinX)) {
        const upper = lock & LockBound.MaxX ? bounds.maxX - Constants.MinWindow : 1 - range;
        minX = clamp(0, original.minX - (evt.pageX - pageXOrigin) * xPerPixel, upper);
        maxX = lock & LockBound.MaxX ? original.maxX : Math.min(1, minX + range);
      } else {
        minX = original.minX;
        maxX = clamp(
          minX + Constants.MinWindow,
          original.maxX - (evt.pageX - pageXOrigin) * xPerPixel,
          1,
        );
      }

      const y =
        lock & LockBound.Y ? bounds.y : clamp(0, original.y - (evt.pageY - pageYOrigin), clampY);
      setBounds({ minX, maxX, y, level: bounds.level });
    };

    const onUp = (evt: MouseEvent) => {
      onMove(evt);
      setDrag(undefined);
    };

    document.addEventListener('mousemove', onMove);
    document.addEventListener('mouseleave', onUp);
    document.addEventListener('mouseup', onUp);

    return () => {
      document.removeEventListener('mousemove', onMove);
      document.removeEventListener('mouseleave', onUp);
      document.removeEventListener('mouseup', onUp);
    };
  }, [clampY, drag]);

  const onMouseMove = useCallback(
    (evt: MouseEvent) => {
      if (!webContext || drag) {
        return;
      }

      const box = getBoxUnderCursor(evt);
      if (!box && hovered?.src === HighlightSource.Keyboard) {
        // don't hide tooltips created by focus change on mousemove
        return;
      }

      setHovered(box ? { box, src: HighlightSource.Hover } : undefined);
    },
    [drag || getBoxUnderCursor, webContext, canvasSize, hovered, rawBoxes],
  );

  const onWheel = useCallback(
    (evt: WheelEvent) => {
      if (!webCanvas.current) {
        return;
      }

      if (evt.altKey) {
        setBounds({ ...bounds, y: clamp(0, bounds.y + evt.deltaY, clampY) });
        return;
      }

      const { left, width } = webCanvas.current.getBoundingClientRect();
      if (evt.shiftKey) {
        const deltaX = clamp(
          0 - bounds.minX,
          (evt.deltaY / width) * (bounds.maxX - bounds.minX),
          1 - bounds.maxX,
        );
        setBounds({ ...bounds, minX: bounds.minX + deltaX, maxX: bounds.maxX + deltaX });
        return;
      }

      const range = bounds.maxX - bounds.minX;
      const center = bounds.minX + (range * (evt.pageX - left)) / width;
      const scale = evt.deltaY / -400;
      setBounds({
        minX: Math.max(0, bounds.minX + scale * (center - bounds.minX)),
        maxX: Math.min(1, bounds.maxX - scale * (bounds.maxX - center)),
        y: bounds.y,
        level: bounds.level,
      });

      evt.preventDefault();
    },
    [clampY, webCanvas.current, drag || bounds],
  );

  const onMouseDown = useCallback(
    (evt: MouseEvent) => {
      setDrag({
        timestamp: Date.now(),
        pageXOrigin: evt.pageX,
        pageYOrigin: evt.pageY,
        xPerPixel: (bounds.maxX - bounds.minX) / canvasSize.width,
        original: bounds,
        lock: LockBound.None,
      });
      evt.preventDefault();
    },
    [canvasSize, drag || bounds],
  );

  const onMouseUp = useCallback(
    (evt: MouseEvent) => {
      if (!drag) {
        return;
      }

      const isClick =
        Date.now() - drag.timestamp < 500 &&
        Math.abs(evt.pageX - drag.pageXOrigin) < 100 &&
        Math.abs(evt.pageY - drag.pageYOrigin) < 100;

      if (!isClick) {
        return;
      }

      const box = getBoxUnderCursor(evt);
      if (box && (evt.ctrlKey || evt.metaKey)) {
        openBox(box, evt);
      } else if (box) {
        zoomToBox(box);
      } else {
        setBounds({ minX: 0, maxX: 1, y: 0, level: 0 });
      }

      setHovered(undefined);
      setDrag(undefined);

      evt.stopPropagation();
      evt.preventDefault();
    },
    [drag, getBoxUnderCursor, openBox, zoomToBox],
  );

  const onMouseLeave = useCallback(
    (evt: MouseEvent) => {
      onMouseUp(evt);
      setHovered(undefined);
    },
    [onMouseUp],
  );

  const onFocus = useCallback(() => {
    if (focused) {
      setHovered({ box: focused, src: HighlightSource.Keyboard });
      return;
    }

    const firstCol = Math.abs(binarySearch(columns, c => c.x2 - bounds.minX));
    const firstBox = getBoxInRowColumn(columns, rawBoxes.boxById, firstCol, 0);
    if (firstBox) {
      setFocused(firstBox);
      setHovered({ box: firstBox, src: HighlightSource.Keyboard });
    }
  }, [rawBoxes, columns, drag || bounds, focused]);

  return (
    <Fragment>
      <DragHandle
        bounds={bounds}
        current={drag}
        canvasWidth={canvasSize.width}
        startDrag={setDrag}
      />
      <canvas
        ref={webCanvas}
        style={{ cursor: hovered ? 'pointer' : 'default' }}
        role="application"
        tabIndex={0}
        onFocus={onFocus}
        onMouseDown={onMouseDown}
        onMouseUp={onMouseUp}
        onMouseLeave={onMouseLeave}
        onMouseMove={onMouseMove}
        onWheel={onWheel}
      />
      <canvas
        ref={glCanvas}
        style={{
          position: 'absolute',
          top: Constants.TimelineHeight,
          left: 0,
          right: 0,
          bottom: 0,
          pointerEvents: 'none',
          zIndex: -1,
        }}
      />
      {hovered && (
        <Tooltip
          canvasWidth={canvasSize.width}
          canvasHeight={canvasSize.height}
          left={(hovered.box.x1 - bounds.minX) / (bounds.maxX - bounds.minX)}
          upperY={canvasSize.height - hovered.box.y1 + bounds.y}
          lowerY={hovered.box.y2 - bounds.y}
          src={hovered.src}
          location={hovered.box.loc}
        />
      )}
      {focused && showInfo && (
        <InfoBox
          columns={columns}
          boxes={rawBoxes.boxById}
          box={focused}
          model={model}
          setFocused={setFocused}
        />
      )}
    </Fragment>
  );
};

const DragHandle: FunctionComponent<{
  canvasWidth: number;
  bounds: IBounds;
  current: IDrag | undefined;
  startDrag: (bounds: IDrag) => void;
}> = ({ current, bounds, startDrag, canvasWidth }) => {
  const start = useCallback(
    (evt: MouseEvent, lock: LockBound, original: IBounds = bounds) => {
      startDrag({
        timestamp: Date.now(),
        pageXOrigin: evt.pageX,
        pageYOrigin: evt.pageY,
        original,
        xPerPixel: -1 / canvasWidth,
        lock: lock | LockBound.Y,
      });
      evt.preventDefault();
      evt.stopPropagation();
    },
    [canvasWidth, bounds],
  );

  const range = bounds.maxX - bounds.minX;
  const lock = current?.lock ?? 0;

  return (
    <div
      className={classes(styles.handle, current && styles.active)}
      style={{ height: Constants.TimelineHeight }}
    >
      <div
        className={classes(styles.bg, lock === LockBound.Y && styles.active)}
        onMouseDown={useCallback((evt: MouseEvent) => start(evt, LockBound.Y), [start])}
        style={{ transform: `scaleX(${range}) translateX(${(bounds.minX / range) * 100}%)` }}
      />
      <div
        className={classes(styles.bookend, lock & LockBound.MaxX && styles.active)}
        style={{ transform: `translateX(${bounds.minX * 100}%)` }}
      >
        <div
          style={{ left: 0 }}
          onMouseDown={useCallback((evt: MouseEvent) => start(evt, LockBound.MaxX), [start])}
        />
      </div>
      <div
        className={classes(styles.bookend, lock & LockBound.MinX && styles.active)}
        style={{ transform: `translateX(${(bounds.maxX - 1) * 100}%)` }}
      >
        <div
          style={{ right: 0 }}
          onMouseDown={useCallback((evt: MouseEvent) => start(evt, LockBound.MinX), [start])}
        />
      </div>
    </div>
  );
};

const Tooltip: FunctionComponent<{
  canvasWidth: number;
  canvasHeight: number;
  left: number;
  upperY: number;
  lowerY: number;
  location: ILocation;
  src: HighlightSource;
}> = ({ left, lowerY, upperY, src, location, canvasWidth, canvasHeight }) => {
  const label = getLocationText(location);
  const above = lowerY + 300 > canvasHeight && lowerY > canvasHeight / 2;

  const file = label?.split(/\\|\//g).pop();
  return (
    <div
      className={styles.tooltip}
      aria-live="polite"
      aria-atomic={true}
      style={{
        left: clamp(0, canvasWidth * left + 10, canvasWidth - 400),
        top: above ? 'initial' : lowerY + 10,
        bottom: above ? upperY + 10 : 'initial',
      }}
    >
      <dl>
        <dt>Function</dt>
        <dd className={styles.function}>{location.callFrame.functionName}</dd>
        {label && (
          <Fragment>
            <dt>File</dt>
            <dd
              aria-label={file}
              className={classes(styles.label, location.src && styles.clickable)}
            >
              <MiddleOut aria-hidden={true} endChars={file?.length} text={label} />
            </dd>
          </Fragment>
        )}
        <dt className={styles.time}>Self Time</dt>
        <dd className={styles.time}>{decimalFormat.format(location.selfTime / 1000)}ms</dd>
        <dt className={styles.time}>Aggregate Time</dt>
        <dd className={styles.time}>{decimalFormat.format(location.aggregateTime / 1000)}ms</dd>
      </dl>
      <div className={styles.hint}>
        Ctrl+{src === HighlightSource.Keyboard ? 'Enter' : 'Click'} to jump to file
      </div>
    </div>
  );
};

const InfoBox: FunctionComponent<{
  box: IBox;
  model: IProfileModel;
  columns: ReadonlyArray<IColumn>;
  boxes: ReadonlyMap<number, IBox>;
  setFocused(box: IBox): void;
}> = ({ columns, boxes, box, model, setFocused }) => {
  const originalLocation = model.locations[box.loc.id];
  const localLocation = box.loc;
  const [limitedStack, setLimitedStack] = useState(true);

  useEffect(() => setLimitedStack(true), [box]);

  const stack = useMemo(() => {
    const stack: IBox[] = [box];
    for (let row = box.row - 1; row >= 0 && stack.length; row--) {
      const b = getBoxInRowColumn(columns, boxes, box.column, row);
      if (b) {
        stack.push(b);
      }
    }

    return stack;
  }, [box, columns, boxes]);

  const shouldTruncateStack = stack.length >= Constants.DefaultStackLimit + 3 && limitedStack;

  return (
    <div className={styles.info}>
      <dl>
        <dt>Self Time</dt>
        <dd>{decimalFormat.format(localLocation.selfTime / 1000)}ms</dd>
        <dt>Total Time</dt>
        <dd>{decimalFormat.format(localLocation.aggregateTime / 1000)}ms</dd>
        <dt>
          Self Time<small>Entire Profile</small>
        </dt>
        <dd>{decimalFormat.format(originalLocation.selfTime / 1000)}ms</dd>
        <dt>
          Total Time<small>Entire Profile</small>
        </dt>
        <dd>{decimalFormat.format(originalLocation.aggregateTime / 1000)}ms</dd>
      </dl>
      <ol start={0}>
        {stack.map(
          (b, i) =>
            (!shouldTruncateStack || i < Constants.DefaultStackLimit) && (
              <li key={i}>
                <BoxLink box={b} onClick={setFocused} link={i > 0} />
              </li>
            ),
        )}
        {shouldTruncateStack && (
          <li>
            <a onClick={() => setLimitedStack(false)}>
              <em>{stack.length - Constants.DefaultStackLimit} more...</em>
            </a>
          </li>
        )}
      </ol>
    </div>
  );
};

const BoxLink: FunctionComponent<{ box: IBox; onClick(box: IBox): void; link?: boolean }> = ({
  box,
  onClick,
  link,
}) => {
  const vscode = useContext(VsCodeApi) as IVscodeApi;
  const open = useCallback(
    (evt: { altKey: boolean }) => {
      const src = box.loc.src;
      if (!src?.source.path) {
        return;
      }

      vscode.postMessage<IOpenDocumentMessage>({
        type: 'openDocument',
        location: src,
        callFrame: box.loc.callFrame,
        toSide: evt.altKey,
      });
    },
    [vscode, box],
  );

  const click = useCallback(() => onClick(box), [box, onClick]);
  const locText = getLocationText(box.loc);
  const linkContent = (
    <Fragment>
      {box.loc.callFrame.functionName} <em>({locText})</em>
    </Fragment>
  );

  return (
    <Fragment>
      {link ? <a onClick={click}>{linkContent}</a> : linkContent}
      {box.loc.src?.source.path && (
        <Icon
          i={GoToFileIcon}
          className={styles.goToFile}
          onClick={open}
          role="button"
          title="Go to File"
        />
      )}
    </Fragment>
  );
};
