import { redirect } from "next/navigation";

// 入口は算定画面。ログインしていなければ proxy.ts がログイン画面へ回す
export default function Home() {
  redirect("/work");
}
