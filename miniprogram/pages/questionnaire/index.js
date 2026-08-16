const { getScale } = require("../../data/scales");
const assessment = require("../../services/assessment");
const { getMissingItems, getNextMissingIndex } = require("../../utils/unanswered");

Page({
  data: {
    currentIndex: 0, total: 0, progress: 0, question: null, selected: 0, answeredCount: 0, canSubmit: false, isLast: false,
    missingCount: 0, showMissingDrawer: false, missingItems: [], missingScrollHeight: 0, reviewingMissing: false,
    choiceWidth: 320, choiceHeight: 56, scrollMode: false,
    choices: [
      { value: 1, label: "非常不准确" }, { value: 2, label: "不太准确" }, { value: 3, label: "适中" },
      { value: 4, label: "比较准确" }, { value: 5, label: "非常准确" },
    ],
  },

  onLoad(options) {
    this.configureLayout();
    this.scale = getScale(options.scaleId);
    if (!this.scale) {
      wx.showToast({ title: "量表不存在", icon: "none" });
      setTimeout(() => wx.navigateBack(), 800);
      return;
    }
    this.session = assessment.getOrCreateSession(this.scale.id, options.restart === "1");
    const lastAnswered = this.scale.items.reduce((last, item, index) => this.session.answers[item.id] ? index : last, -1);
    const savedIndex = Number.isInteger(this.session.currentIndex) ? this.session.currentIndex : lastAnswered + 1;
    const startIndex = Math.min(Math.max(savedIndex, 0), this.scale.itemCount - 1);
    wx.setNavigationBarTitle({ title: this.scale.title });
    this.showQuestion(startIndex);
  },

  configureLayout(providedInfo) {
    const windowInfo = providedInfo || (wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync());
    const windowWidth = Math.max(240, Number(windowInfo.windowWidth) || 375);
    const windowHeight = Math.max(240, Number(windowInfo.windowHeight) || 667);
    const screenHeight = Number(windowInfo.screenHeight) || windowHeight;
    const safeBottom = windowInfo.safeArea ? Math.max(0, screenHeight - Number(windowInfo.safeArea.bottom || screenHeight)) : 0;
    const rpx = windowWidth / 750;
    const compact = windowHeight <= 700;
    const reservedRpx = compact ? 374 : 472;
    const availablePerChoice = (windowHeight - safeBottom - reservedRpx * rpx) / 5;
    // 保留两行中文题目/选项的内容空间，极窄屏时由 scrollMode 提供滚动兜底。
    const minimumChoiceHeight = Math.max(64, 128 * rpx);
    this.setData({
      choiceWidth: Math.floor(windowWidth - 64 * rpx),
      choiceHeight: Math.floor(Math.max(minimumChoiceHeight, availablePerChoice)),
      scrollMode: availablePerChoice < minimumChoiceHeight,
    });
  },

  onResize(event) {
    const size = event && event.size ? event.size : {};
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    this.configureLayout({ ...windowInfo, ...size });
  },

  showQuestion(index) {
    const question = this.scale.items[index];
    this.session = assessment.updateSessionPosition(this.session, index);
    const answeredCount = Object.keys(this.session.answers).length;
    this.setData({
      currentIndex: index, total: this.scale.itemCount, progress: Math.round(((index + 1) / this.scale.itemCount) * 100),
      question, selected: this.session.answers[question.id] || 0, answeredCount,
      canSubmit: answeredCount === this.scale.itemCount, isLast: index === this.scale.itemCount - 1,
      missingCount: this.scale.itemCount - answeredCount,
      reviewingMissing: Boolean(this.reviewingMissing),
    });
  },

  chooseAnswer(event) {
    const value = Number(event.currentTarget.dataset.value);
    const item = this.scale.items[this.data.currentIndex];
    this.session = assessment.answerQuestion(this.session, item.id, value, this.data.currentIndex);
    const answeredCount = Object.keys(this.session.answers).length;
    const canSubmit = answeredCount === this.scale.itemCount;
    this.setData({ selected: value, answeredCount, canSubmit, missingCount: this.scale.itemCount - answeredCount });

    if (this.reviewingMissing) {
      const nextMissing = getNextMissingIndex(this.scale.items, this.session.answers, this.data.currentIndex);
      if (nextMissing >= 0) {
        clearTimeout(this.advanceTimer);
        this.advanceTimer = setTimeout(() => this.showQuestion(nextMissing), 180);
      } else {
        this.reviewingMissing = false;
        this.setData({ reviewingMissing: false });
      }
      return;
    }
    if (this.data.currentIndex < this.scale.itemCount - 1) {
      clearTimeout(this.advanceTimer);
      this.advanceTimer = setTimeout(() => this.showQuestion(this.data.currentIndex + 1), 180);
    }
  },

  previous() {
    this.clearAdvanceTimer();
    this.reviewingMissing = false;
    if (this.data.currentIndex > 0) this.showQuestion(this.data.currentIndex - 1);
  },
  next() {
    this.clearAdvanceTimer();
    this.reviewingMissing = false;
    if (this.data.currentIndex < this.scale.itemCount - 1) this.showQuestion(this.data.currentIndex + 1);
  },
  openMissingDrawer() {
    this.clearAdvanceTimer();
    if (!this.data.missingCount) {
      wx.showToast({ title: "所有题目已回答", icon: "none" });
      return;
    }
    const missingItems = getMissingItems(this.scale.items, this.session.answers, this.data.currentIndex);
    const windowInfo = wx.getWindowInfo ? wx.getWindowInfo() : wx.getSystemInfoSync();
    const rowCount = Math.ceil(missingItems.length / 6);
    const missingScrollHeight = Math.min(Math.round(windowInfo.windowHeight * 0.48), Math.max(64, rowCount * 45 + 12));
    this.setData({
      showMissingDrawer: true,
      missingItems,
      missingScrollHeight,
    });
  },
  closeMissingDrawer() {
    this.setData({ showMissingDrawer: false, missingItems: [], missingScrollHeight: 0 });
  },
  keepDrawerOpen() {},
  jumpToMissing(event) {
    this.clearAdvanceTimer();
    const index = Number(event.currentTarget.dataset.index);
    this.reviewingMissing = true;
    this.setData({ showMissingDrawer: false, missingItems: [], missingScrollHeight: 0, reviewingMissing: true });
    this.showQuestion(index);
  },
  findMissing() {
    this.openMissingDrawer();
  },
  submit() {
    if (this.submitting) return;
    if (!this.data.canSubmit) {
      wx.showToast({ title: `还有 ${this.scale.itemCount - this.data.answeredCount} 题未完成`, icon: "none" });
      this.openMissingDrawer();
      return;
    }
    this.submitting = true;
    wx.showLoading({ title: "生成报告" });
    assessment.completeSession(this.session).then((result) => {
      wx.hideLoading();
      wx.redirectTo({ url: `/pages/result/index?resultId=${result.resultId}` });
    }).catch(() => {
      this.submitting = false;
      wx.hideLoading();
      wx.showToast({ title: "生成失败，请检查答案", icon: "none" });
    });
  },
  restart() {
    this.clearAdvanceTimer();
    wx.showModal({ title: "重新开始当前测试", content: "当前量表已填写的全部答案都会被清除，此操作无法撤销。", confirmText: "确认重开", confirmColor: "#B54848", success: ({ confirm }) => {
      if (confirm) {
        this.reviewingMissing = false;
        this.session = assessment.getOrCreateSession(this.scale.id, true);
        this.setData({ showMissingDrawer: false, missingItems: [], missingScrollHeight: 0, reviewingMissing: false });
        this.showQuestion(0);
      }
    } });
  },
  clearAdvanceTimer() {
    clearTimeout(this.advanceTimer);
    this.advanceTimer = null;
  },
  onUnload() { this.clearAdvanceTimer(); },
});
