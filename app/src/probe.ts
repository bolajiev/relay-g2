/** Probe: native list container for the brief + its event model. */
import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  OsEventTypeList,
  TextContainerProperty,
  waitForEvenAppBridge,
} from '@evenrealities/even_hub_sdk'

const bridge = await waitForEvenAppBridge()

const list = new ListContainerProperty({
  xPosition: 16,
  yPosition: 44,
  width: 544,
  height: 196,
  borderWidth: 0,
  paddingLength: 4,
  containerID: 2,
  containerName: 'inbox',
  isEventCapture: 1,
  zOrderIndex: 2,
  itemContainer: new ListItemContainerProperty({
    itemCount: 3,
    itemWidth: 532,
    isItemSelectBorderEn: 1,
    itemName: [
      'Ana Ruiz · 2m — Send latest deck before review',
      'Launch team · 9m — Approve $2k offsite budget',
      'Daniel Okafor · 41m — Share ARR',
    ],
  }),
})

const header = new TextContainerProperty({
  xPosition: 16,
  yPosition: 0,
  width: 544,
  height: 40,
  borderWidth: 0,
  paddingLength: 2,
  containerID: 3,
  containerName: 'header',
  content: 'RELAY · 5 WAITING · DEMO',
  textColor: 3,
  isEventCapture: 0,
  zOrderIndex: 3,
})

const footer = new TextContainerProperty({
  xPosition: 16,
  yPosition: 248,
  width: 544,
  height: 40,
  borderWidth: 0,
  paddingLength: 2,
  containerID: 4,
  containerName: 'footer',
  content: 'TAP open · SWIPE move · HOLD refresh',
  textColor: 2,
  isEventCapture: 0,
  zOrderIndex: 4,
})

const result = await bridge.createStartUpPageContainer(
  new CreateStartUpPageContainer({
    containerTotalNum: 3,
    listObject: [list],
    textObject: [header, footer],
  }),
)
console.log(`PROBE_LIST_READY create=${result}`)

bridge.onEvenHubEvent(event => {
  const e = event as unknown as {
    listEvent?: { eventType?: number; currentSelectItemIndex?: number; currentSelectItemName?: string }
    sysEvent?: { eventType?: number; eventSource?: number }
    textEvent?: { eventType?: number }
  }
  if (e.listEvent) {
    console.log(`EVT list type=${String(e.listEvent.eventType)} idx=${String(e.listEvent.currentSelectItemIndex)} name=${e.listEvent.currentSelectItemName ?? ''}`)
  }
  if (e.sysEvent) console.log(`EVT sys type=${String(e.sysEvent.eventType)} src=${String(e.sysEvent.eventSource)}`)
  if (e.textEvent) console.log(`EVT text type=${String(e.textEvent.eventType)}`)
  if (e.sysEvent?.eventType === OsEventTypeList.DOUBLE_CLICK_EVENT) bridge.shutDownPageContainer(1)
})
