async function kernelPost<T = unknown>(url: string, body: unknown = {}): Promise<T> {
  const response = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  if (!response.ok) throw new Error(`${url}: HTTP ${response.status}`);

  const result = await response.json();
  if (result.code !== 0) throw new Error(result.msg || `${url}: code ${result.code}`);
  return result.data as T;
}

export interface BlockInsertionTarget {
  nextID?: string;
  previousID?: string;
  parentID?: string;
}

export interface InsertedBlock {
  id: string;
  dom: string;
}

interface KernelOperation {
  action?: string;
  id?: string;
  data?: string;
}

interface KernelTransaction {
  doOperations?: KernelOperation[];
}

export async function insertMarkdownBlock(
  markdown: string,
  target: BlockInsertionTarget,
): Promise<InsertedBlock> {
  if (!target.nextID && !target.previousID && !target.parentID) {
    throw new Error("缺少插入位置");
  }

  const transactions = await kernelPost<KernelTransaction[]>("/api/block/insertBlock", {
    dataType: "markdown",
    data: markdown,
    nextID: target.nextID ?? "",
    previousID: target.previousID ?? "",
    parentID: target.parentID ?? "",
  });

  const operation = transactions
    .flatMap((transaction) => transaction.doOperations ?? [])
    .find((item) => item.action === "insert" && item.id);

  if (!operation?.id) throw new Error("思源没有返回新插入块的 ID");
  return { id: operation.id, dom: operation.data ?? "" };
}

export async function setBlockAttrs(id: string, attrs: Record<string, string>): Promise<void> {
  await kernelPost("/api/attr/setBlockAttrs", { id, attrs });
}

export async function deleteBlock(id: string): Promise<void> {
  await kernelPost("/api/block/deleteBlock", { id });
}

export async function getBlockKramdown(id: string): Promise<string> {
  const data = await kernelPost<{ kramdown?: string }>("/api/block/getBlockKramdown", { id });
  return data?.kramdown ?? "";
}
