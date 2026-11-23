import {
  CreateStartUpPageContainer,
  ListContainerProperty,
  ListItemContainerProperty,
  MenuContainerProperty,
  MenuItemProperty,
  RebuildPageContainer,
  TextContainerProperty,
  TextContainerUpgrade,
  type EvenAppBridge,
} from '@evenrealities/even_hub_sdk'
import type { ListBox, TextBox, View } from './views'

export class GlassUI {
  private created = false

  constructor(private readonly bridge: EvenAppBridge) {}

  private textContainers(boxes: TextBox[]): TextContainerProperty[] {
    return boxes.map(
      b =>
        new TextContainerProperty({
          xPosition: b.x,
          yPosition: b.y,
          width: b.w,
          height: b.h,
          borderWidth: b.border ?? 0,
          borderColor: b.borderColor ?? 5,
          borderRadius: b.radius ?? 0,
          paddingLength: b.pad ?? 4,
          containerID: b.id,
          containerName: b.name,
          isEventCapture: b.capture ? 1 : 0,
          zOrderIndex: b.id,
          content: b.content,
          textColor: b.color,
        }),
    )
  }

  private listContainer(list: ListBox): ListContainerProperty {
    return new ListContainerProperty({
      xPosition: list.x,
      yPosition: list.y,
      width: list.w,
      height: list.h,
      borderWidth: list.border ?? 0,
      borderColor: list.borderColor ?? 5,
      paddingLength: list.pad ?? 2,
      containerID: list.id,
      containerName: list.name,
      isEventCapture: 1,
      zOrderIndex: list.id,
      itemContainer: new ListItemContainerProperty({
        itemCount: list.items.length,
        itemWidth: list.itemWidth,
        isItemSelectBorderEn: 1,
        itemName: list.items,
      }),
    })
  }

  private menu(view: View): MenuContainerProperty | undefined {
    if (!view.menu.length) return undefined
    return new MenuContainerProperty({
      menuItems: view.menu.map(m => new MenuItemProperty({ itemName: m.name, itemID: m.id })),
    })
  }

  async render(view: View): Promise<boolean> {
    const textObject = this.textContainers(view.boxes)
    const listObject = view.list ? [this.listContainer(view.list)] : undefined
    const total = textObject.length + (listObject?.length ?? 0)

    if (!this.created) {
      const result = await this.bridge.createStartUpPageContainer(
        new CreateStartUpPageContainer({
          containerTotalNum: total,
          textObject,
          listObject,
          menuObject: this.menu(view),
        }),
      )
      if (result !== 0) {
        console.error(`RELAY create page failed: ${result}`)
        return false
      }
      this.created = true
      return true
    }

    const ok = await this.bridge.rebuildPageContainer(
      new RebuildPageContainer({
        containerTotalNum: total,
        textObject,
        listObject,
        menuObject: this.menu(view),
      }),
    )
    if (!ok) console.error('RELAY rebuild page failed')
    return ok
  }

  async update(id: number, name: string, content: string, color?: number): Promise<boolean> {
    return this.bridge.textContainerUpgrade(
      new TextContainerUpgrade({
        containerID: id,
        containerName: name,
        content,
        textColor: color,
      }),
    )
  }

  async shutdown(): Promise<void> {
    await this.bridge.shutDownPageContainer(1)
  }
}
