## 1. 把你 Fork 后的仓库克隆到本地

```
# 克隆【你自己账号下fork出来的仓库】，不是原项目地址！
git clone https://github.com/你的用户名/项目名.git
cd 项目名
```

### （重要！添加上游源，用来同步原仓库后续更新）

```
# upstream 指代【原始作者的仓库】
git remote add upstream https://github.com/原作者用户名/项目名.git

# 查看远程，确认 origin=你的fork，upstream=原项目
git remote -v
```

## 2. 新建开发分支，在分支上修改代码

```
# 切到主分支（main/master），保证基线干净
git checkout main

# 拉取原项目最新代码，避免后续冲突
git fetch upstream
git rebase upstream/main

# 创建并切换新分支，名字见名知意，比如fix-bug、add-feature
git checkout -b fix-somebug
```

现在在这个新分支里，修改代码、修复 bug、新增功能。

## 3. 本地提交改动

```
# 把改动加入暂存区（.代表所有改动文件）
git add .

# 提交，写清晰的提交说明（改了什么，解决什么问题）
git commit -m "fix: 修复XX功能报错"
```

## 4. 推送到你自己 GitHub 上的 Fork 仓库

```
# 推送到 origin（也就是你账号下fork的仓库）的这个分支
git push origin fix-somebug
```

## 5. 在 GitHub 网页发起 Pull Request（PR）

1. 打开 GitHub 上**你 fork 的仓库页面**，推送完分支后，页面顶部一般会自动弹出 `Compare & pull request` 按钮，直接点它；
2. 如果没有弹窗：切换到 Pull requests 标签页，点`New pull request`；
3. **重点核对两边仓库**：
   - `base repository`：选**原始作者的仓库**，分支一般是 `main`（原项目主分支）
   - `head repository`：**你的 fork 仓库**，分支是你刚才推送的 `fix-somebug`
4. 填写 PR 标题 + 描述：写清楚**做了什么改动、目的是什么**；如果对应 issue，可以写 `Closes #123`（合并后自动关闭 123 号 issue）
5. 点击 `Create pull request` 提交，等待原项目维护者评审代码。

## 6. 评审后续：维护者提意见需要改代码

你只需要**在本地同一个分支继续修改、commit、push**，PR 会自动更新，不用新建 PR：

```
git checkout fix-somebug
# 修改代码
git add .
git commit -m "refactor: 根据评审调整逻辑"
git push origin fix-somebug
```

## 7. 后续同步原项目更新（经常用到）

原作者在 main 分支合并了新代码，你本地 fork 仓库需要同步：

```
git checkout main
git fetch upstream
git rebase upstream/main
git push origin main
```

---

# 常见踩坑提醒

1. ❌ 不要在 main 分支直接改代码提 PR，后续同步上游、多个 PR 会冲突混乱；
2. ❌ 克隆地址不要拿成原项目地址，origin 必须是你自己 fork 的仓库；
3. ⚠️ 提交前尽量跑项目自测，保证代码能正常运行；很多开源项目有 CI 自动测试，失败了 PR 会被卡住；
4. ⚠️ 冲突：如果原项目同一文件同期改了，会出现代码冲突，需要本地 rebase 解决冲突再 push。
