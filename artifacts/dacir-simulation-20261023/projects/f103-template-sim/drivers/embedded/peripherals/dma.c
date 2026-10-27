/* Modified 2026-10-23: generic file and API names; original license retained. */
/**
 * @file    dma.c
 * @date    2026-08-01
 * @brief   DMA 驱动源文件
 *         基于 HAL 库封装 DMA1 通道初始化、启动、停止及中断回调的实现
 */

#include "interrupts.h"
#include "dma.h"

/**
 * @brief DMA 通道上下文结构
 *        保存句柄、传输完成回调及初始化标志
 */
typedef struct
{
    DMA_HandleTypeDef handle;       /* HAL DMA 句柄                  */
    dma_callback_t    tc_cb;        /* 传输完成回调函数              */
    void             *cb_arg;      /* 回调用户参数                  */
    volatile void    *periph_addr; /* 固定外设地址 */
    void             *mem_addr;    /* 自增内存地址 */
    uint32            size;        /* 默认传输个数 */
    uint32            alignment;   /* 地址对齐字节数 */
    uint8             init_flag;   /* 初始化完成标志 (1=已初始化)    */
} dma_ctx_t;

static void dma_transfer_complete(DMA_HandleTypeDef *hdma);

static dma_ctx_t dma_ctx[DMA_CH_COUNT];  /* DMA1 各通道上下文实例 */

/* DMA1 通道实例数组,索引与 dma_channel_enum 对应 */
static DMA_Channel_TypeDef *const dma_channel[] =
{
    DMA1_Channel1, DMA1_Channel2, DMA1_Channel3, DMA1_Channel4,
    DMA1_Channel5, DMA1_Channel6, DMA1_Channel7,
};

/**
 * @brief  初始化 DMA 通道
 * @param  ch          : DMA 通道,见 dma_channel_enum
 * @param  dir         : 传输方向,见 dma_dir_enum
 * @param  width       : 数据位宽,见 dma_width_enum
 * @param  periph_addr : 外设地址
 * @param  mem_addr    : 内存地址
 * @param  size        : 传输数据个数
 * @param  circular    : 是否循环模式 (1=循环, 0=单次)
 * @retval 无
 * @note   固定外设地址不自增、内存地址自增,优先级为中
 */
void dma_init (dma_channel_enum ch, dma_dir_enum dir, dma_width_enum width,
               volatile void *periph_addr, void *mem_addr, uint32 size, uint8 circular)
{
    if ((unsigned)ch >= DMA_CH_COUNT) return;   /* 通道越界直接返回 */

    if ((unsigned)dir > DMA_DIR_P2M || (unsigned)width > DMA_WIDTH_32BIT ||
        size > 65535U) return;

    dma_ctx_t *ctx = &dma_ctx[ch];
    /* 不在传输过程中重配置；调用者应先停止通道。 */
    if (ctx->init_flag && ctx->handle.State == HAL_DMA_STATE_BUSY) return;
    ctx->init_flag = 0;

    __HAL_RCC_DMA1_CLK_ENABLE();      /* 使能 DMA1 时钟 */

    DMA_HandleTypeDef *hdma = &ctx->handle;
    hdma->Instance = dma_channel[ch];

    /* 根据方向配置内存↔外设 */
    if (dir == DMA_DIR_M2P)
        hdma->Init.Direction = DMA_MEMORY_TO_PERIPH;
    else
        hdma->Init.Direction = DMA_PERIPH_TO_MEMORY;

    hdma->Init.PeriphInc           = DMA_PINC_DISABLE;   /* 外设地址不自增 */
    hdma->Init.MemInc              = DMA_MINC_ENABLE;    /* 内存地址自增   */

    /* 根据位宽配置外设与内存的数据对齐 */
    switch (width)
    {
        case DMA_WIDTH_8BIT:
            hdma->Init.PeriphDataAlignment = DMA_PDATAALIGN_BYTE;
            hdma->Init.MemDataAlignment    = DMA_MDATAALIGN_BYTE;
            break;
        case DMA_WIDTH_16BIT:
            hdma->Init.PeriphDataAlignment = DMA_PDATAALIGN_HALFWORD;
            hdma->Init.MemDataAlignment    = DMA_MDATAALIGN_HALFWORD;
            break;
        case DMA_WIDTH_32BIT:
            hdma->Init.PeriphDataAlignment = DMA_PDATAALIGN_WORD;
            hdma->Init.MemDataAlignment    = DMA_MDATAALIGN_WORD;
            break;
    }

    hdma->Init.Mode    = circular ? DMA_CIRCULAR : DMA_NORMAL;  /* 循环/正常模式 */
    hdma->Init.Priority = DMA_PRIORITY_MEDIUM;                   /* 中优先级      */

    if (HAL_DMA_Init(hdma) != HAL_OK) return;
    ctx->periph_addr = periph_addr;
    ctx->mem_addr = mem_addr;
    ctx->size = size;
    ctx->alignment = 1U << (unsigned)width;
    hdma->XferCpltCallback = dma_transfer_complete;

    /* 配置并使能对应通道中断 */
    IRQn_Type irq[] =
    {
        DMA1_Channel1_IRQn, DMA1_Channel2_IRQn, DMA1_Channel3_IRQn, DMA1_Channel4_IRQn,
        DMA1_Channel5_IRQn, DMA1_Channel6_IRQn, DMA1_Channel7_IRQn,
    };
    interrupt_set_priority(irq[ch], 1, 0);
    interrupt_enable(irq[ch]);

    ctx->init_flag = 1;   /* 标记初始化完成 */
}

/**
 * @brief  启动 DMA 传输
 * @param  ch   : DMA 通道,见 dma_channel_enum
 * @param  size : 传输数据个数
 * @retval 无
 * @note   使用 dma_init 保存的地址；size 为 0 时沿用初始化长度。
 *         NULL 地址、未对齐地址或无效长度不启动传输。
 */
void dma_start (dma_channel_enum ch, uint32 size)
{
    if ((unsigned)ch >= DMA_CH_COUNT || !dma_ctx[ch].init_flag) return;
    dma_ctx_t *ctx = &dma_ctx[ch];
    if (size == 0) size = ctx->size;
    if (!ctx->periph_addr || !ctx->mem_addr || size == 0 || size > 65535U ||
        (uintptr_t)ctx->periph_addr % ctx->alignment ||
        (uintptr_t)ctx->mem_addr % ctx->alignment ||
        ctx->handle.State != HAL_DMA_STATE_READY) return;

    uint32 periph = (uint32)(uintptr_t)ctx->periph_addr;
    uint32 mem = (uint32)(uintptr_t)ctx->mem_addr;
    ctx->handle.XferCpltCallback = dma_transfer_complete;
    if (ctx->handle.Init.Direction == DMA_MEMORY_TO_PERIPH)
        HAL_DMA_Start_IT(&ctx->handle, mem, periph, size);
    else
        HAL_DMA_Start_IT(&ctx->handle, periph, mem, size);
}

/**
 * @brief  停止 DMA 传输
 * @param  ch: DMA 通道,见 dma_channel_enum
 * @retval 无
 */
void dma_stop (dma_channel_enum ch)
{
    if ((unsigned)ch >= DMA_CH_COUNT || !dma_ctx[ch].init_flag) return;
    HAL_DMA_Abort(&dma_ctx[ch].handle);
}

/**
 * @brief  查询 DMA 剩余传输数据量
 * @param  ch: DMA 通道,见 dma_channel_enum
 * @retval 剩余未传输的数据个数
 */
uint32 dma_remaining (dma_channel_enum ch)
{
    if ((unsigned)ch >= DMA_CH_COUNT || !dma_ctx[ch].init_flag) return 0;   /* 通道越界返回 0 */
    return __HAL_DMA_GET_COUNTER(&dma_ctx[ch].handle);
}

/**
 * @brief  设置 DMA 传输完成回调
 * @param  ch : DMA 通道,见 dma_channel_enum
 * @param  cb : 回调函数指针
 * @param  arg: 回调用户参数
 * @retval 无
 */
void dma_set_callback (dma_channel_enum ch, dma_callback_t cb, void *arg)
{
    if ((unsigned)ch >= DMA_CH_COUNT) return;   /* 通道越界直接返回 */
    dma_ctx[ch].tc_cb  = cb;
    dma_ctx[ch].cb_arg = arg;
}

/**
 * @brief  获取 DMA 通道句柄
 * @param  ch: DMA 通道,见 dma_channel_enum
 * @retval DMA 句柄指针;通道越界返回 NULL
 */
DMA_HandleTypeDef * dma_get_handle (dma_channel_enum ch)
{
    if ((unsigned)ch >= DMA_CH_COUNT) return NULL;   /* 通道越界返回 NULL */
    return &dma_ctx[ch].handle;
}

/**
 * @brief  HAL DMA 传输完成回调
 * @param  hdma: DMA 句柄指针
 * @retval 无
 * @note   遍历各通道,匹配到对应实例后调用用户注册的回调
 */
static void dma_transfer_complete (DMA_HandleTypeDef *hdma)
{
    for (uint8 i = 0; i < DMA_CH_COUNT; i++)
    {
        if (hdma == &dma_ctx[i].handle && dma_ctx[i].init_flag && dma_ctx[i].tc_cb)
        {
            dma_ctx[i].tc_cb(dma_ctx[i].cb_arg);   /* 调用用户回调 */
            break;
        }
    }
}

/* DMA1 各通道中断服务函数,转发至 HAL_DMA_IRQHandler */
void DMA1_Channel1_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH1].handle); }
void DMA1_Channel2_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH2].handle); }
void DMA1_Channel3_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH3].handle); }
void DMA1_Channel4_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH4].handle); }
void DMA1_Channel5_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH5].handle); }
void DMA1_Channel6_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH6].handle); }
void DMA1_Channel7_IRQHandler (void) { HAL_DMA_IRQHandler(&dma_ctx[DMA_CH7].handle); }
